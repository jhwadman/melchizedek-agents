/**
 * Calling a REMOTE agent over A2A (lib/a2a/remoteAgent.ts), end to end and
 * offline: a real A2A server (lib/a2a/app.ts) on an ephemeral localhost port
 * plays the remote agent, with scripted models on both sides.
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
import { a2aAuthHeaders, advertisedEndpoints, RemoteA2AAgent } from '../lib/a2a/remoteAgent.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import { ScriptedLlm, call, scriptedResolver, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const SECRET = 'remote-secret-0123456789abcdef0123456789';
const dir = mkdtempSync(join(tmpdir(), 'melch-remote-'));
writeFileSync(join(dir, 'oracle.yaml'), 'syndicate_name: Oracle\norchestrator:\n  name: Oracle\n  model: scripted/oracle\n  instruction: Answer.\nsubagents: []\n');
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

let server: Server;
let base = '';

before(async () => {
  const built = await createA2AApp({
    defaultSyndicate: 'oracle.yaml',
    serverSecret: SECRET,
    storage: { sessionService: new InMemorySessionService() },
    keyMode: 'byok',
    resolveModel: () => new ScriptedLlm('scripted/oracle', (req) => text(`oracle heard: ${sentTexts(req).join(' | ')}`)),
    log: () => {},
    warn: () => {},
  });
  server = await new Promise((resolve) => {
    const s = built.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  process.env.ALLOW_PRIVATE_A2A = 'true';
  process.env.A2A_AGENT_TOKENS = JSON.stringify({ '127.0.0.1': { Authorization: `Bearer ${SECRET}`, 'X-API-Key': 'k' } });
});

after(() => {
  server?.close();
  delete process.env.ALLOW_PRIVATE_A2A;
  delete process.env.A2A_AGENT_TOKENS;
});

test('a local orchestrator delegates to a remote agent, and the remote conversation persists', async () => {
  const sessions = new InMemorySessionService();
  const boss = new ScriptedLlm('scripted/boss', (req, n) => {
    const toolResult = JSON.stringify(req.contents?.at(-1) ?? '');
    return n % 2 === 1 ? call('Oracle', { request: n === 1 ? 'first question' : 'second question' }) : text(`relay: ${toolResult}`);
  });
  const config = {
    syndicate_name: 'Local',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Ask the oracle.' },
    subagents: [{ name: 'Oracle', description: 'A remote oracle', a2a_agent_url: base }],
  } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      config,
      parts: [{ text: msg }],
      appName: 'local',
      userId: 'u',
      sessionId: 'conv-1',
      sessionService: sessions,
      compile: { resolveModel: scriptedResolver({ boss }) },
      trace: false,
    });
  const first = await run('go');
  assert.equal(first.status, 'completed');
  assert.match(first.text, /oracle heard: first question/);
  const second = await run('again');
  // Same local conversation → same remote contextId → the remote saw turn one.
  assert.match(second.text, /first question/);
  assert.match(second.text, /second question/);
});

test('a plan-dispatch route can be a remote agent', async () => {
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Oracle"}'));
  const config = {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Route.' },
    subagents: [
      { name: 'Chat', model: 'scripted/router', instruction: 'x', description: 'chat' },
      { name: 'Oracle', description: 'remote', a2a_agent_url: base },
    ],
    dispatch: { default_route: 'Chat' },
  } as any;
  const r = await runSyndicateTurn({
    config,
    parts: [{ text: 'route me' }],
    appName: 'local',
    userId: 'u',
    sessionId: 'conv-2',
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: scriptedResolver({ router }) },
    trace: false,
  });
  assert.equal(r.status, 'completed');
  assert.match(r.text, /oracle heard: route me/);
});

test('a card that points its endpoint at a private address is refused', async () => {
  const realFetch = globalThis.fetch;
  delete process.env.ALLOW_PRIVATE_A2A;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        name: 'Evil', description: 'points inward', protocolVersion: '0.3.0', version: '1',
        url: 'http://169.254.169.254/a2a', preferredTransport: 'JSONRPC',
        capabilities: {}, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
  const { setHostResolver } = await import('../lib/net/addressGuard.ts');
  setHostResolver(async () => [{ address: '93.184.216.34' }]);
  try {
    await assert.rejects(new RemoteA2AAgent('https://agents.example').resolve(), /link-local|metadata/);
  } finally {
    globalThis.fetch = realFetch;
    setHostResolver();
    process.env.ALLOW_PRIVATE_A2A = 'true';
  }
});

test('every endpoint a card advertises is collected for the SSRF check, 1.0 and 0.3 shapes alike', () => {
  assert.deepEqual(advertisedEndpoints({ supportedInterfaces: [{ url: 'https://a/rpc' }, { url: 'https://a/rest' }] }), ['https://a/rpc', 'https://a/rest']);
  assert.deepEqual(advertisedEndpoints({ url: 'https://a/rpc', additionalInterfaces: [{ url: 'https://a/rest' }] }), ['https://a/rpc', 'https://a/rest']);
});

test('a remote agent that speaks only A2A 1.0 is reachable', async () => {
  // Serve a 1.0-only card: drop the 0.3 mirror interfaces from our own server's card.
  const card = (await (await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0', Authorization: `Bearer ${SECRET}` } })).json()) as any;
  card.supportedInterfaces = card.supportedInterfaces.filter((i: any) => i.protocolVersion === '1.0');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (href.endsWith('/v1-only/.well-known/agent-card.json')) return new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } });
    return realFetch(input, init);
  }) as typeof fetch;
  try {
    const answer = await new RemoteA2AAgent(`${base}/v1-only`).send('hello over 1.0');
    assert.equal(answer.state, 'completed');
    assert.match(answer.text, /oracle heard: hello over 1\.0/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('credentials go only to the exact host, over https or to loopback', () => {
  const env = { A2A_AGENT_TOKENS: JSON.stringify({ 'agents.example': 'tok', localhost: 'dev' }) };
  assert.deepEqual(a2aAuthHeaders(new URL('https://agents.example/x'), env), { Authorization: 'Bearer tok' });
  assert.deepEqual(a2aAuthHeaders(new URL('http://agents.example/x'), env), {});
  assert.deepEqual(a2aAuthHeaders(new URL('https://evil.example/x'), env), {});
  assert.deepEqual(a2aAuthHeaders(new URL('http://localhost:4000/x'), env), { Authorization: 'Bearer dev' });
});
