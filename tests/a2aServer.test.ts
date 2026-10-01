/**
 * HTTP-level tests of the A2A server (lib/a2a/app.ts) on an ephemeral port,
 * with scripted models and in-memory persistence. No network beyond
 * localhost and no provider calls. Covers the contract a client depends on:
 * health routes, auth, agent cards, a blocking send, session resumption by
 * message.contextId, cancellation, refused parts and unknown agents.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import type { A2AApp } from '../lib/a2a/app.ts';
import { ScriptedLlm, hangUntilAborted, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'test-secret-0123456789abcdef0123456789';
const dir = mkdtempSync(join(tmpdir(), 'melch-a2a-'));
writeFileSync(join(dir, 'echo.yaml'), [
  'syndicate_name: Echo',
  'memory_system: session-only',
  'orchestrator:',
  '  name: Echo',
  '  model: scripted/echo',
  '  instruction: Echo.',
  'subagents: []',
].join('\n'));
writeFileSync(join(dir, 'slow.yaml'), [
  'syndicate_name: Slow',
  'orchestrator:',
  '  name: Slow',
  '  model: scripted/slow',
  '  instruction: Hang.',
  'subagents: []',
].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

let echoCalls = 0;
const models: Record<string, () => ScriptedLlm> = {
  echo: () => new ScriptedLlm('scripted/echo', (req) => {
    echoCalls += 1;
    return text(`echo #${echoCalls}: ${sentTexts(req).join(' | ')}`);
  }),
  slow: () => new ScriptedLlm('scripted/slow', (_req, _n, signal) => hangUntilAborted(signal)),
};

let built: A2AApp;
let server: Server;
let base = '';

before(async () => {
  built = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    keyMode: 'byok',
    resolveModel: (id) => models[(id ?? '').replace('scripted/', '')](),
    log: () => {},
    warn: () => {},
  });
  server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => {
  server?.close();
});

const auth = { Authorization: `Bearer ${SECRET}` };
const caller = { ...auth, 'X-API-Key': 'caller-key', 'Content-Type': 'application/json' };

async function rpc(path: string, method: string, params: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: caller,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

function message(textValue: string, contextId?: string, extraParts: unknown[] = []) {
  return {
    message: {
      kind: 'message',
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ kind: 'text', text: textValue }, ...extraParts],
      ...(contextId ? { contextId } : {}),
    },
  };
}

test('health routes answer without credentials', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal(((await ready.json()) as any).status, 'ready');
});

test('a request without the bearer secret is refused', async () => {
  const res = await fetch(`${base}/.well-known/agent-card.json`);
  assert.equal(res.status, 401);
});

test('the agent card needs the bearer but not a model key, and declares its auth', async () => {
  const res = await fetch(`${base}/.well-known/agent-card.json`, { headers: auth });
  assert.equal(res.status, 200);
  const card = (await res.json()) as any;
  assert.ok(card.securitySchemes.bearer);
  assert.ok(card.securitySchemes.apiKey);
  assert.match(card.url, /\/a2a\/jsonrpc$/);
});

test('a per-agent card advertises that agent’s own endpoint', async () => {
  const res = await fetch(`${base}/slow/.well-known/agent-card.json`, { headers: auth });
  assert.equal(res.status, 200);
  const card = (await res.json()) as any;
  assert.equal(card.name, 'Slow');
  assert.match(card.url, /\/slow\/a2a\/jsonrpc$/);
});

test('message/send returns the answer, and message.contextId resumes the session', async () => {
  const contextId = `ctx-${crypto.randomUUID()}`;
  const first = await rpc('/a2a/jsonrpc', 'message/send', message('hello there', contextId));
  assert.equal(first.status, 200);
  assert.equal(first.body.result.status.state, 'completed');
  const second = await rpc('/a2a/jsonrpc', 'message/send', message('and again', contextId));
  const answer = second.body.result.status.message.parts[0].text as string;
  assert.match(answer, /hello there/, 'the second turn must see the first');
  assert.match(answer, /and again/);
});

test('a file part is refused rather than silently blanked', async () => {
  const r = await rpc('/a2a/jsonrpc', 'message/send', message('see file', undefined, [{ kind: 'file', file: { uri: 'http://169.254.169.254/' } }]));
  assert.equal(r.body.result.status.state, 'rejected');
});

test('tasks/cancel stops a running task', async () => {
  const sent = await rpc('/slow/a2a/jsonrpc', 'message/send', { ...message('wait'), configuration: { blocking: false } });
  const taskId = sent.body.result.id;
  assert.ok(taskId);
  await new Promise((r) => setTimeout(r, 50));
  const canceled = await rpc('/slow/a2a/jsonrpc', 'tasks/cancel', { id: taskId });
  assert.equal(canceled.body.result?.status?.state, 'canceled', JSON.stringify(canceled.body));
});

test('an unknown agent is a generic 404 that leaks no server path', async () => {
  const res = await fetch(`${base}/nope/.well-known/agent-card.json`, { headers: auth });
  assert.equal(res.status, 404);
  const body = await res.text();
  assert.ok(!body.includes(dir), 'the agents directory must not appear in the response');
});

// ── Server key mode, the identity plug point, and agent resolution ───────────

async function serve(options: Record<string, unknown>) {
  const app = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    storage: { sessionService: new InMemorySessionService() },
    resolveModel: (id: string | undefined) => models[(id ?? '').replace('scripted/', '')](),
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

async function send(url: string, headers: Record<string, string>, text: string, contextId: string) {
  const res = await fetch(`${url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message/send', params: message(text, contextId) }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

test('server key mode needs no X-API-Key, and X-User-Id scopes the conversation', async () => {
  const { srv, url } = await serve({ keyMode: 'server' });
  try {
    const ctx = `ctx-${crypto.randomUUID()}`;
    const a = await send(url, { 'X-User-Id': 'alice' }, 'alice says hi', ctx);
    assert.equal(a.body.result.status.state, 'completed');
    // Same contextId, different user: a different scope, so a fresh session.
    const b = await send(url, { 'X-User-Id': 'bob' }, 'bob says hi', ctx);
    assert.doesNotMatch(b.body.result.status.message.parts[0].text, /alice says hi/);
    const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as any;
    assert.equal(card.securitySchemes?.apiKey, undefined, 'no X-API-Key scheme outside BYOK');
  } finally {
    srv.close();
  }
});

test('resolveRequest supplies the scope key and can refuse a request', async () => {
  const { srv, url } = await serve({
    resolveRequest: (req: any) => (req.headers['x-test-token'] === 'ok' ? { scopeKey: 'tenant-7/user-1' } : undefined),
  });
  try {
    assert.equal((await send(url, {}, 'no token', 'c1')).status, 401);
    const ok = await send(url, { 'X-Test-Token': 'ok' }, 'with token', 'c1');
    assert.equal(ok.body.result.status.state, 'completed');
  } finally {
    srv.close();
  }
});

test('a bare id never resolves to a shipped example unless the operator serves it', async () => {
  // tutor.yaml exists only under the repo's examples/, not in this agents dir.
  const examplesDir = join(process.cwd(), 'config', 'agents');
  const prev = process.env.MELCHIZEDEK_AGENTS_DIR;
  process.env.MELCHIZEDEK_AGENTS_DIR = examplesDir;
  const unserved = await serve({ keyMode: 'server', defaultSyndicate: 'examples/tutor.yaml' });
  const served = await serve({ keyMode: 'server', defaultSyndicate: 'examples/tutor.yaml', servedAgents: ['tutor'] });
  try {
    assert.equal((await fetch(`${unserved.url}/tutor/.well-known/agent-card.json`)).status, 404);
    assert.equal((await fetch(`${served.url}/tutor/.well-known/agent-card.json`)).status, 200);
  } finally {
    unserved.srv.close();
    served.srv.close();
    process.env.MELCHIZEDEK_AGENTS_DIR = prev;
  }
});

test('registry:<id> without a registry is a clean not-found, never a file substitute', async () => {
  const { srv, url } = await serve({ keyMode: 'server', registryAgents: ['slow'] });
  try {
    // 'slow' has a file, but the operator said it lives in the registry, and
    // there is no registry here: it must not quietly fall back to the file.
    const res = await fetch(`${url}/slow/.well-known/agent-card.json`);
    assert.notEqual(res.status, 200);
  } finally {
    srv.close();
  }
});

test('an A2A 1.0 client gets the 1.0 card and can send with SendMessage', async () => {
  const v1 = { ...auth, 'A2A-Version': '1.0', 'Content-Type': 'application/json', 'X-API-Key': 'caller-key' };
  const card = (await (await fetch(`${base}/.well-known/agent-card.json`, { headers: v1 })).json()) as any;
  assert.ok(Array.isArray(card.supportedInterfaces), '1.0 cards list supportedInterfaces');
  const versions = new Set(card.supportedInterfaces.map((i: any) => i.protocolVersion));
  assert.ok(versions.has('1.0') && versions.has('0.3'), 'both protocol versions are advertised');
  const res = await fetch(`${base}/a2a/jsonrpc`, {
    method: 'POST',
    headers: v1,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'hello from 1.0' }] } },
    }),
  });
  const body = (await res.json()) as any;
  assert.ok(!body.error, JSON.stringify(body.error));
  const task = body.result.task ?? body.result;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.match(JSON.stringify(task.status.message), /hello from 1\.0/);
});

test('a task belongs to the caller that created it', async () => {
  const { srv, url } = await serve({ keyMode: 'server' });
  const rpcAs = async (user: string, method: string, params: unknown) => {
    const res = await fetch(`${url}/slow/a2a/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-User-Id': user },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return (await res.json()) as any;
  };
  try {
    const sent = await rpcAs('alice', 'message/send', { ...message('mine'), configuration: { blocking: false } });
    const taskId = sent.result.id;
    assert.ok(taskId);
    const asBob = await rpcAs('bob', 'tasks/get', { id: taskId });
    assert.ok(asBob.error, 'another caller must not see the task');
    const bobCancel = await rpcAs('bob', 'tasks/cancel', { id: taskId });
    assert.ok(bobCancel.error, 'another caller must not cancel the task');
    const asAlice = await rpcAs('alice', 'tasks/get', { id: taskId });
    assert.equal(asAlice.result?.id, taskId);
    await rpcAs('alice', 'tasks/cancel', { id: taskId });
  } finally {
    srv.close();
  }
});
