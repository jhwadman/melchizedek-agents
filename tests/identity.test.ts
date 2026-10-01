/**
 * tests/identity.test.ts — the built-in authenticators (lib/a2a/identity.ts,
 * ADR 0025), unit-level and through a live createA2AApp on an ephemeral
 * port. Scripted models, in-memory sessions; no provider calls.
 *
 * The property that matters most: a caller token mapped to an existing
 * key-hash silo reaches the same conversations the shared secret did, so a
 * deployment moves to per-caller tokens without moving any data, and model
 * key rotation stops mattering.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

import { createA2AApp, currentRequestContext } from '../lib/a2a/app.ts';
import { deriveUserId } from '../lib/a2a/executor.ts';
import {
  callerTokens,
  firstOf,
  hashCallerToken,
  jwtIdentity,
  parseCallers,
  scopeSegment,
  sharedSecret,
  trustedHeader,
} from '../lib/a2a/identity.ts';
import { ScriptedLlm, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const dir = mkdtempSync(join(tmpdir(), 'melch-identity-'));
writeFileSync(join(dir, 'echo.yaml'), [
  'syndicate_name: Echo',
  'memory_system: session-only',
  'orchestrator:',
  '  name: Echo',
  '  model: scripted/echo',
  '  instruction: Echo.',
].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

const echo = () => new ScriptedLlm('scripted/echo', (req) => text(`heard: ${sentTexts(req).join(' | ')}`));

/** A fake request carrying only headers, for the unit tests. */
const req = (headers: Record<string, string>) =>
  ({ headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) }) as any;

const ALPHA = 'alpha-token-0123456789abcdefghijklmnop';
const BETA = 'beta-token-0123456789abcdefghijklmnopqrst';
const SECRET = 'legacy-secret-0123456789abcdef0123456789'; // gitleaks:allow (test fixture)
const MODEL_KEY = 'fixture-model-key';
const SILO = deriveUserId({ apiKey: MODEL_KEY });

// ── Caller tokens ────────────────────────────────────────────────────────────

test('parseCallers reads name:sha256[:scope] and refuses what it cannot trust', () => {
  const h = hashCallerToken(ALPHA);
  assert.deepEqual(parseCallers(`alpha:${h}:a2a-0123456789abcdef; beta:${hashCallerToken(BETA)}`), [
    { name: 'alpha', tokenSha256: h, scope: 'a2a-0123456789abcdef' },
    { name: 'beta', tokenSha256: hashCallerToken(BETA), scope: 'beta' },
  ]);
  assert.throws(() => parseCallers(`alpha:${ALPHA}`), /SHA-256/, 'a raw token is refused');
  assert.throws(() => parseCallers(`a:${h}; b:${h}`), /reuses/);
  assert.throws(() => parseCallers(`a:${h}; a:${hashCallerToken(BETA)}`), /twice/);
  assert.throws(() => parseCallers(`bad name:${h}`), /must match/);
  assert.throws(() => parseCallers(' ; '), /no callers/);
});

test('callerTokens: the scope is the caller’s, an end user nests beneath it', async () => {
  const auth = callerTokens(parseCallers(`alpha:${hashCallerToken(ALPHA)}:${SILO}`));
  assert.deepEqual(await auth.resolveRequest(req({ Authorization: `Bearer ${ALPHA}` })), {
    scopeKey: SILO,
    caller: 'alpha',
    ownsNested: true,
    operator: true,
  });
  const nested = await auth.resolveRequest(req({ Authorization: `Bearer ${ALPHA}`, 'X-User-Id': 'u1' }));
  assert.equal(nested?.scopeKey, `${SILO}/u1`);
  assert.equal(nested?.ownsNested, false);
  assert.equal(await auth.resolveRequest(req({ Authorization: `Bearer ${BETA}` })), undefined);
  assert.equal(await auth.resolveRequest(req({ Authorization: `Bearer ${ALPHA}`, 'X-User-Id': 'a/b' })), undefined);
  assert.equal(await auth.resolveRequest(req({})), undefined);
});

test('sharedSecret reproduces the pre-0.16 scoping exactly', async () => {
  const byok = sharedSecret({ secret: SECRET, keyMode: 'byok' });
  const id = await byok.resolveRequest(req({ Authorization: `Bearer ${SECRET}`, 'X-API-Key': MODEL_KEY }));
  assert.equal(id?.scopeKey, SILO);
  const user = await byok.resolveRequest(req({ Authorization: `Bearer ${SECRET}`, 'X-API-Key': MODEL_KEY, 'X-User-Id': 'u1' }));
  assert.equal(user?.scopeKey, deriveUserId({ apiKey: MODEL_KEY, siteUserId: 'u1' }));
  const server = sharedSecret({ secret: SECRET, keyMode: 'server' });
  assert.equal((await server.resolveRequest(req({ Authorization: `Bearer ${SECRET}` })))?.scopeKey, 'default');
  assert.equal(await server.resolveRequest(req({ Authorization: 'Bearer wrong' })), undefined);
});

test('scopeSegment keeps readable ids and hashes the rest without collisions', () => {
  assert.equal(scopeSegment('user-42'), 'user-42');
  const a = scopeSegment('auth0|42');
  const b = scopeSegment('auth0_42');
  assert.match(a, /^h-[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.notEqual(scopeSegment('h-spoof'), 'h-spoof', 'a value cannot pose as a hashed segment');
});

// ── JWT ──────────────────────────────────────────────────────────────────────

const JWT_SECRET = 'jwt-secret-0123456789abcdef0123456789abcdef'; // gitleaks:allow (test fixture)
const hs = new TextEncoder().encode(JWT_SECRET);
async function token(claims: Record<string, unknown>, opts: { exp?: string; iss?: string; aud?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.iss ?? 'https://idp.example')
    .setAudience(opts.aud ?? 'melchizedek')
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(hs);
}

test('jwtIdentity verifies issuer, audience and expiry, and scopes by tenant/user', async () => {
  const auth = jwtIdentity({ secret: JWT_SECRET, issuer: 'https://idp.example', audience: 'melchizedek', tenantClaim: 'org' });
  const ok = await auth.resolveRequest(req({ Authorization: `Bearer ${await token({ sub: 'auth0|42', org: 'acme' })}` }));
  assert.equal(ok?.scopeKey, `acme/${scopeSegment('auth0|42')}`);
  await assert.rejects(async () => auth.resolveRequest(req({ Authorization: `Bearer ${await token({ sub: 'x', org: 'acme' }, { aud: 'other' })}` })) as Promise<unknown>);
  await assert.rejects(async () => auth.resolveRequest(req({ Authorization: `Bearer ${await token({ sub: 'x', org: 'acme' }, { iss: 'https://evil' })}` })) as Promise<unknown>);
  await assert.rejects(async () => auth.resolveRequest(req({ Authorization: `Bearer ${await token({ sub: 'x', org: 'acme' }, { exp: '-10m' })}` })) as Promise<unknown>);
  await assert.rejects(async () => auth.resolveRequest(req({ Authorization: `Bearer ${await token({ sub: 'x' })}` })) as Promise<unknown>, /org/);
  assert.equal(await auth.resolveRequest(req({ Authorization: `Bearer ${ALPHA}` })), undefined, 'not a JWT');
});

test('jwtIdentity accepts asymmetric keys through a key resolver and refuses a forged token', async () => {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const forger = await generateKeyPair('ES256');
  const auth = jwtIdentity({ getKey: async () => publicKey, issuer: 'iss', audience: 'aud' });
  const sign = (key: Parameters<SignJWT['sign']>[0]) =>
    new SignJWT({ sub: 'u1' }).setProtectedHeader({ alg: 'ES256' }).setIssuer('iss').setAudience('aud').setExpirationTime('5m').sign(key);
  assert.equal((await auth.resolveRequest(req({ Authorization: `Bearer ${await sign(privateKey)}` })))?.scopeKey, 'u1');
  await assert.rejects(async () => auth.resolveRequest(req({ Authorization: `Bearer ${await sign(forger.privateKey)}` })) as Promise<unknown>);
  assert.ok(await exportJWK(publicKey));
});

test('jwtIdentity refuses an unsafe configuration', () => {
  assert.throws(() => jwtIdentity({ secret: 'short', issuer: 'i', audience: 'a' }), /32 characters/);
  assert.throws(() => jwtIdentity({ issuer: 'i', audience: 'a' }), /exactly one/);
  assert.throws(() => jwtIdentity({ secret: JWT_SECRET, issuer: '', audience: 'a' }), /issuer and audience/);
});

test('firstOf tries in order and reports why nothing matched', async () => {
  const auth = firstOf(jwtIdentity({ secret: JWT_SECRET, issuer: 'https://idp.example', audience: 'melchizedek' }), sharedSecret({ secret: SECRET, keyMode: 'server' }));
  assert.equal((await auth.resolveRequest(req({ Authorization: `Bearer ${SECRET}` })))?.caller, 'shared-secret');
  await assert.rejects(
    () => auth.resolveRequest(req({ Authorization: `Bearer ${'x'.repeat(10)}.${'y'.repeat(10)}.${'z'.repeat(10)}` })) as Promise<unknown>,
  );
});

// ── Through the server ───────────────────────────────────────────────────────

const erased: Array<{ scopeKey: string; includeNested?: boolean }> = [];

async function serve(options: Record<string, unknown>) {
  const app = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    storage: {
      sessionService: new InMemorySessionService(),
      erase: async (scopeKey: string, o: { includeNested?: boolean }) => {
        erased.push({ scopeKey, includeNested: o.includeNested });
        return { memory_facts: 0 } as any;
      },
    },
    resolveModel: () => echo(),
    // An operator-only adopter route, the way a deployment mounts its own.
    routes: (app: any) =>
      app.post('/v1/operator-only', (_req: any, res: any) =>
        res.status(currentRequestContext()?.operator ? 200 : 403).json({ caller: currentRequestContext()?.caller })),
    log: () => {},
    warn: () => {},
    ...options,
  } as any);
  const srv: Server = await new Promise((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address();
  return { srv, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

async function send(url: string, headers: Record<string, string>, said: string, contextId: string) {
  const res = await fetch(`${url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: said }], contextId } },
    }),
  });
  const body = (await res.json()) as any;
  return { status: res.status, answer: body?.result?.status?.message?.parts?.[0]?.text as string | undefined };
}

async function erasedScope(url: string, headers: Record<string, string>) {
  erased.length = 0;
  const res = await fetch(`${url}/memory`, { method: 'DELETE', headers });
  assert.equal(res.status, 200);
  return erased[0];
}

test('a caller token on the old silo reaches the conversation the shared secret started', async () => {
  const callers = parseCallers(`alpha:${hashCallerToken(ALPHA)}:${SILO}; beta:${hashCallerToken(BETA)}`);
  const { srv, url } = await serve({ keyMode: 'byok', ...firstOf(callerTokens(callers), sharedSecret({ secret: SECRET, keyMode: 'byok' })) });
  try {
    const ctx = `ctx-${crypto.randomUUID()}`;
    const legacy = { Authorization: `Bearer ${SECRET}`, 'X-API-Key': MODEL_KEY };
    assert.equal((await send(url, legacy, 'first, over the shared secret', ctx)).status, 200);

    // Same silo through alpha's own token, even with a ROTATED model key.
    const alpha = { Authorization: `Bearer ${ALPHA}`, 'X-API-Key': 'fixture-rotated-key' };
    const resumed = await send(url, alpha, 'second, over a caller token', ctx);
    assert.match(resumed.answer ?? '', /first, over the shared secret/);

    // beta owns a different scope: the same context id is a fresh session.
    const beta = { Authorization: `Bearer ${BETA}`, 'X-API-Key': MODEL_KEY };
    assert.doesNotMatch((await send(url, beta, 'beta here', ctx)).answer ?? '', /first, over the shared secret/);

    // Caller tokens and the shared secret are operator credentials.
    const op = (h: Record<string, string>) =>
      fetch(`${url}/v1/operator-only`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: '{}' }).then((r) => r.status);
    assert.equal(await op(alpha), 200);
    assert.equal(await op(legacy), 200);

    // Erasure follows the authenticated scope.
    assert.deepEqual(await erasedScope(url, alpha), { scopeKey: SILO, includeNested: true });
    assert.deepEqual(await erasedScope(url, { ...alpha, 'X-User-Id': 'u1' }), { scopeKey: `${SILO}/u1`, includeNested: false });
  } finally {
    srv.close();
  }
});

test('byok billing holds under an authenticator: no X-API-Key, no task', async () => {
  const { srv, url } = await serve({ keyMode: 'byok', ...callerTokens(parseCallers(`alpha:${hashCallerToken(ALPHA)}`)) });
  try {
    assert.equal((await send(url, { Authorization: `Bearer ${ALPHA}` }, 'hi', 'c1')).status, 401);
    assert.equal((await send(url, { Authorization: `Bearer ${ALPHA}`, 'X-API-Key': MODEL_KEY }, 'hi', 'c1')).status, 200);
    assert.equal((await send(url, { Authorization: `Bearer ${BETA}`, 'X-API-Key': MODEL_KEY }, 'hi', 'c1')).status, 401);
    assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401, 'a card is not public');
    const card = (await (await fetch(`${url}/.well-known/agent-card.json`, { headers: { Authorization: `Bearer ${ALPHA}` } })).json()) as any;
    assert.match(JSON.stringify(card.securitySchemes?.bearer ?? {}), /own token/);
    assert.ok(card.securitySchemes?.apiKey, 'byok still declares X-API-Key');
  } finally {
    srv.close();
  }
});

test('a JWT caller runs in server key mode with the token as the user', async () => {
  const auth = jwtIdentity({ secret: JWT_SECRET, issuer: 'https://idp.example', audience: 'melchizedek' });
  const { srv, url } = await serve({ keyMode: 'server', ...auth });
  try {
    const bearer = { Authorization: `Bearer ${await token({ sub: 'user-9' })}` };
    assert.equal((await send(url, bearer, 'hi', 'c1')).status, 200);
    assert.deepEqual(await erasedScope(url, { ...bearer, 'X-User-Id': 'someone-else' }), { scopeKey: 'user-9', includeNested: false });
    assert.equal((await send(url, { Authorization: `Bearer ${await token({ sub: 'u' }, { exp: '-10m' })}` }, 'hi', 'c1')).status, 401);
    const op = await fetch(`${url}/v1/operator-only`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...bearer }, body: '{}' });
    assert.equal(op.status, 403, 'an end user’s JWT is not an operator credential');
    assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401, 'a card is not public');
    const card = (await (await fetch(`${url}/.well-known/agent-card.json`, { headers: bearer })).json()) as any;
    assert.match(JSON.stringify(card.securitySchemes?.bearer ?? {}), /JWT/);
  } finally {
    srv.close();
  }
});

test('a trusted header needs the server secret, and is read only behind it', async () => {
  await assert.rejects(() => serve({ ...trustedHeader({ header: 'X-Authenticated-User' }) }), /serverSecret/);
  const { srv, url } = await serve({ serverSecret: SECRET, ...trustedHeader({ header: 'X-Authenticated-User' }) });
  try {
    assert.equal((await send(url, { 'X-Authenticated-User': 'alice' }, 'hi', 'c1')).status, 401, 'no bearer, no entry');
    const gateway = { Authorization: `Bearer ${SECRET}`, 'X-Authenticated-User': 'alice@example.com' };
    assert.equal((await send(url, gateway, 'hi', 'c1')).status, 200);
    assert.deepEqual(await erasedScope(url, gateway), { scopeKey: scopeSegment('alice@example.com'), includeNested: false });
    const card = (await (await fetch(`${url}/.well-known/agent-card.json`, { headers: { Authorization: `Bearer ${SECRET}` } })).json()) as any;
    assert.equal(card.securitySchemes?.identity?.name ?? card.securitySchemes?.identity?.apiKeySecurityScheme?.name, 'X-Authenticated-User');
  } finally {
    srv.close();
  }
});

test('plain secret mode: the secret is an operator credential; no secret, no operator', async () => {
  const xp = (url: string, h: Record<string, string>) =>
    fetch(`${url}/v1/operator-only`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: '{}' }).then((r) => r.status);
  const gated = await serve({ serverSecret: SECRET, keyMode: 'server' });
  const open = await serve({ keyMode: 'server' });
  try {
    assert.equal(await xp(gated.url, { Authorization: `Bearer ${SECRET}` }), 200);
    assert.equal(await xp(open.url, {}), 403);
  } finally {
    gated.srv.close();
    open.srv.close();
  }
});
