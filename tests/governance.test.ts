/**
 * tests/governance.test.ts — usage, budgets, metrics and per-caller rate
 * limits (ADR 0026), offline: scripted models, in-memory stores, a live
 * createA2AApp on an ephemeral port.
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
import type { LlmResponse } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import { callerTokens, hashCallerToken, parseCallers } from '../lib/a2a/identity.ts';
import { budgets, memoryUsageStore, parseBudgets } from '../lib/a2a/policy.ts';
import type { UsageStore } from '../lib/a2a/policy.ts';
import { createMetrics } from '../lib/observability/metrics.ts';
import type { TaskRecord } from '../lib/observability/metrics.ts';
import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, sentTexts } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

/** A reply that reports token usage, as a real provider does. */
const answer = (t: string): LlmResponse =>
  ({
    content: { role: 'model', parts: [{ text: t }] },
    turnComplete: true,
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
  }) as LlmResponse;
const echo = () => new ScriptedLlm('scripted/echo', (req) => answer(`heard: ${sentTexts(req).join(' | ')}`));

const dir = mkdtempSync(join(tmpdir(), 'melch-governance-'));
writeFileSync(join(dir, 'echo.yaml'), [
  'syndicate_name: Echo',
  'orchestrator:',
  '  name: Echo',
  '  model: scripted/echo',
  '  instruction: Echo.',
].join('\n'));
process.env.MELCHIZEDEK_AGENTS_DIR = dir;

// ── Usage ────────────────────────────────────────────────────────────────────

test('a turn reports its model calls and the tokens the provider counted', async () => {
  const r = await runSyndicateTurn({
    config: { syndicate_name: 'Echo', orchestrator: { name: 'Echo', model: 'scripted/echo', instruction: 'Echo.' }, subagents: [] } as SyndicateYamlConfig,
    parts: [{ text: 'hi' }],
    appName: 'test',
    userId: 'u',
    sessionId: 's-usage',
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: () => echo() },
    trace: false,
  });
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.usage, { llmCalls: 1, inputTokens: 100, outputTokens: 20, thinkingTokens: 5 });
});

// ── Budgets ──────────────────────────────────────────────────────────────────

const subject = { caller: 'penguin', scopeKey: 'silo-1', agentId: 'echo' };
const spend = { llmCalls: 3, inputTokens: 1000, outputTokens: 200, thinkingTokens: 0 };

test('budgets refuse a caller at its daily task limit, per caller, and reset the next UTC day', async () => {
  let now = new Date('2026-10-01T10:00:00Z');
  const policy = budgets({ perCaller: { tasks: 2 }, callers: { ymir: { tasks: 1 } } }, { now: () => now });
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await policy.admit!(subject), { ok: true });
    await policy.record!(subject, spend);
  }
  const refused = await policy.admit!(subject);
  assert.equal(refused.ok, false);
  assert.match((refused as any).reason, /Caller 'penguin' has used today's budget of 2 tasks/);

  const ymir = { ...subject, caller: 'ymir', scopeKey: 'silo-2' };
  assert.equal((await policy.admit!(ymir)).ok, true, 'another caller has its own budget');
  await policy.record!(ymir, spend);
  assert.equal((await policy.admit!(ymir)).ok, false, 'an override replaces perCaller');

  now = new Date('2026-10-02T00:00:01Z');
  assert.equal((await policy.admit!(subject)).ok, true, 'a new UTC day starts over');
});

test('budgets count tokens and model calls, and per scope', async () => {
  const now = () => new Date('2026-10-01T10:00:00Z');
  const tokens = budgets({ perCaller: { tokens: 2_000 } }, { now });
  await tokens.record!(subject, spend);
  assert.equal((await tokens.admit!(subject)).ok, true);
  await tokens.record!(subject, spend);
  assert.match((await tokens.admit!(subject) as any).reason, /2,000 tokens/);

  const calls = budgets({ perCaller: { llmCalls: 3 } }, { now });
  await calls.record!(subject, spend);
  assert.match((await calls.admit!(subject) as any).reason, /3 model calls/);

  const perScope = budgets({ perScope: { tasks: 1 } }, { now });
  await perScope.record!(subject, spend);
  assert.match((await perScope.admit!(subject) as any).reason, /This user/);
  assert.equal((await perScope.admit!({ ...subject, scopeKey: 'silo-1/other-user' })).ok, true);
});

test('parseBudgets names the bad key', () => {
  assert.deepEqual(parseBudgets('{"perCaller":{"tasks":5}}'), { perCaller: { tasks: 5 } });
  assert.throws(() => parseBudgets('{"perCaller":{"task":5}}'), /perCaller/);
  assert.throws(() => parseBudgets('{"perCaller":{"tasks":-1}}'), /perCaller\.tasks/);
  assert.throws(() => parseBudgets('nope'), /not valid JSON/);
});

// ── Metrics ──────────────────────────────────────────────────────────────────

test('metrics render Prometheus text with cumulative histogram buckets', () => {
  const m = createMetrics();
  const base: TaskRecord = { agentId: 'echo', syndicate: 'Echo', caller: 'penguin', scopeHash: 'abc', status: 'completed', durationMs: 3000, usage: spend };
  m.observeTask(base);
  m.observeTask({ ...base, durationMs: 50_000 });
  m.observeTask({ ...base, status: 'rejected', reason: 'policy', usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 } });
  const out = m.render(2);
  assert.match(out, /melchizedek_a2a_tasks_total\{agent="echo",caller="penguin",reason="",status="completed"\} 2/);
  assert.match(out, /melchizedek_a2a_tasks_total\{agent="echo",caller="penguin",reason="policy",status="rejected"\} 1/);
  assert.match(out, /melchizedek_a2a_tokens_total\{agent="echo",caller="penguin",kind="input"\} 2000/);
  assert.match(out, /melchizedek_a2a_task_duration_seconds_bucket\{agent="echo",le="5"\} 1/);
  assert.match(out, /melchizedek_a2a_task_duration_seconds_bucket\{agent="echo",le="60"\} 2/);
  assert.match(out, /melchizedek_a2a_task_duration_seconds_count\{agent="echo"\} 2/);
  assert.match(out, /melchizedek_a2a_tasks_in_flight 2/);
  assert.doesNotMatch(out, /abc/, 'a scope never becomes a label');
});

// ── Through the server ───────────────────────────────────────────────────────

const PENGUIN = 'penguin-token-0123456789abcdefghijklmnop';
const YMIR = 'ymir-token-0123456789abcdefghijklmnopqrst';
const METRICS = 'metrics-token-0123456789abcdefghijklmn';
const callers = parseCallers(`penguin:${hashCallerToken(PENGUIN)}; ymir:${hashCallerToken(YMIR)}`);

async function serve(options: Record<string, unknown>) {
  const app = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    storage: { sessionService: new InMemorySessionService() },
    resolveModel: () => echo(),
    log: () => {},
    warn: () => {},
    ...callerTokens(callers),
    ...options,
  } as any);
  const srv: Server = await new Promise((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address();
  return { srv, url: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

async function send(url: string, token: string) {
  const res = await fetch(`${url}/a2a/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: { message: { kind: 'message', messageId: crypto.randomUUID(), role: 'user', parts: [{ kind: 'text', text: 'hi' }], contextId: crypto.randomUUID() } },
    }),
  });
  const body = res.status === 200 ? ((await res.json()) as any) : undefined;
  return { status: res.status, state: body?.result?.status?.state as string | undefined, text: body?.result?.status?.message?.parts?.[0]?.text as string | undefined };
}

test('a caller over budget is rejected with the reason; metrics and task records say so', async () => {
  const records: TaskRecord[] = [];
  const { srv, url } = await serve({
    policy: budgets({ perCaller: { tasks: 2 } }),
    metricsToken: METRICS,
    onTaskEnd: (r: TaskRecord) => records.push(r),
  });
  try {
    assert.equal((await send(url, PENGUIN)).state, 'completed');
    assert.equal((await send(url, PENGUIN)).state, 'completed');
    const third = await send(url, PENGUIN);
    assert.equal(third.state, 'rejected');
    assert.match(third.text ?? '', /budget of 2 tasks/);
    assert.equal((await send(url, YMIR)).state, 'completed', 'ymir has its own budget');

    assert.deepEqual(records.map((r) => [r.caller, r.status, r.reason ?? '']), [
      ['penguin', 'completed', ''],
      ['penguin', 'completed', ''],
      ['penguin', 'rejected', 'policy'],
      ['ymir', 'completed', ''],
    ]);
    assert.deepEqual(records[0].usage, { llmCalls: 1, inputTokens: 100, outputTokens: 20, thinkingTokens: 5 });
    assert.match(records[0].scopeHash, /^[0-9a-f]{12}$/);

    assert.equal((await fetch(`${url}/metrics`)).status, 401);
    assert.equal((await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${PENGUIN}` } })).status, 401, 'a caller token is not a scrape token');
    const metrics = await (await fetch(`${url}/metrics`, { headers: { Authorization: `Bearer ${METRICS}` } })).text();
    assert.match(metrics, /melchizedek_a2a_tasks_total\{agent="default",caller="penguin",reason="policy",status="rejected"\} 1/);
    assert.match(metrics, /melchizedek_a2a_llm_calls_total\{agent="default",caller="ymir"\} 1/);
  } finally {
    srv.close();
  }
});

test('a policy that cannot read its store refuses (fail closed)', async () => {
  const broken: UsageStore = { get: async () => { throw new Error('db down'); }, add: async () => {} };
  const { srv, url } = await serve({ policy: budgets({ perCaller: { tasks: 10 } }, { store: broken }) });
  try {
    const r = await send(url, PENGUIN);
    assert.equal(r.state, 'rejected');
    assert.match(r.text ?? '', /could not check its usage limits/);
  } finally {
    srv.close();
  }
});

test('with an authenticator the rate limit is per caller, not per IP', async () => {
  const { srv, url } = await serve({ rateLimit: { windowMs: 60_000, max: 1 } });
  try {
    assert.equal((await send(url, PENGUIN)).status, 200);
    assert.equal((await send(url, PENGUIN)).status, 429, 'penguin is over its own limit');
    assert.equal((await send(url, YMIR)).status, 200, 'ymir, on the same IP, is not');
  } finally {
    srv.close();
  }
});

test('the memory usage store keeps the last two days only', async () => {
  const store = memoryUsageStore();
  const d = { tasks: 1, llmCalls: 1, inputTokens: 1, outputTokens: 1, thinkingTokens: 0 };
  await store.add('2026-09-01', 'caller:x', d);
  await store.add('2026-10-01', 'caller:x', d);
  assert.equal((await store.get('2026-09-01', 'caller:x')).tasks, 0, 'an old day is dropped');
  assert.equal((await store.get('2026-10-01', 'caller:x')).tasks, 1);
});

// ── Redaction ────────────────────────────────────────────────────────────────

test('the default redactor removes key-shaped secrets and leaves ordinary text', async () => {
  const { telemetryRedactor } = await import('../lib/observability/redact.ts');
  const r = telemetryRedactor({})!;
  const fakeGoogle = 'AIza' + 'x'.repeat(35);
  const out = r(`my key is ${fakeGoogle} and Bearer ${'t'.repeat(30)} — price $1,234 on 2026-10-01`);
  assert.doesNotMatch(out, /AIzax/);
  assert.match(out, /\[redacted:secret\].*\[redacted:secret\]/);
  assert.match(out, /price \$1,234 on 2026-10-01/);
  assert.equal(telemetryRedactor({ TELEMETRY_REDACT: 'off' }), undefined);
});

test('opt-in kinds: email, phone, card (Luhn only), ssn', async () => {
  const { telemetryRedactor } = await import('../lib/observability/redact.ts');
  const r = telemetryRedactor({ TELEMETRY_REDACT: 'all' })!;
  const out = r('mail a.b@example.com, call +1 415 555 0134, card 4111 1111 1111 1111, order 1234 5678 9012 3456, ssn 123-45-6789');
  assert.match(out, /mail \[redacted:email\]/);
  assert.match(out, /call \[redacted:phone\]/);
  assert.match(out, /card \[redacted:card\]/);
  assert.match(out, /order 1234 5678 9012 3456/, 'a number that fails Luhn is not a card');
  assert.match(out, /ssn \[redacted:ssn\]/);
  assert.throws(() => telemetryRedactor({ TELEMETRY_REDACT: 'email,passport' }), /unknown kind/);
});

test('redactRow rewrites text values and keeps identifier columns', async () => {
  const { patternRedactor, redactRow } = await import('../lib/observability/redact.ts');
  const r = patternRedactor(['email']);
  const row = {
    trace_id: 'a@b.co', session_id: 'x@y.io', user_id: 'u@v.io', model: 'gemini', span: { traceId: 'c@d.co', note: 'n@m.co' },
    input: 'write to me@corp.com', output: 'ok', tool_events: [{ name: 'web', args: { to: 'z@q.org' } }], latency_ms: 12,
  };
  const out = redactRow(row, r);
  assert.equal(out.trace_id, 'a@b.co');
  assert.equal(out.user_id, 'u@v.io');
  assert.equal(out.input, 'write to [redacted:email]');
  assert.equal((out.tool_events[0].args as any).to, '[redacted:email]');
  assert.equal(out.latency_ms, 12);
  assert.deepEqual(out.span, { traceId: 'c@d.co', note: '[redacted:email]' });
});

test('under the plain shared secret every holder is one caller, so perCaller budgets apply', async () => {
  const SECRET = 'shared-secret-0123456789abcdef0123456789';
  const records: TaskRecord[] = [];
  const app = await createA2AApp({
    defaultSyndicate: 'echo.yaml',
    storage: { sessionService: new InMemorySessionService() },
    resolveModel: () => echo(),
    serverSecret: SECRET,
    keyMode: 'server',
    policy: budgets({ perCaller: { tasks: 1 } }),
    onTaskEnd: (r: TaskRecord) => records.push(r),
    log: () => {},
    warn: () => {},
  } as any);
  const srv: Server = await new Promise((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  try {
    assert.equal((await send(url, SECRET)).state, 'completed');
    const second = await send(url, SECRET);
    assert.equal(second.state, 'rejected');
    assert.match(second.text ?? '', /Caller 'shared-secret'/);
    assert.deepEqual(records.map((r) => r.caller), ['shared-secret', 'shared-secret']);
  } finally {
    srv.close();
  }
});

test('the usage counters name a scope only by its hash', async () => {
  const store = memoryUsageStore();
  const seen: string[] = [];
  const spy: UsageStore = { get: (d, s) => store.get(d, s), add: async (d, s, u) => { seen.push(s); await store.add(d, s, u); } };
  const policy = budgets({ perScope: { tasks: 5 } }, { store: spy });
  await policy.record!({ caller: 'penguin', scopeKey: 'alice@example.com', agentId: '' }, spend);
  assert.ok(seen.includes('caller:penguin'));
  const scope = seen.find((x) => x.startsWith('scope:'))!;
  assert.match(scope, /^scope:[0-9a-f]{24}$/);
  assert.doesNotMatch(scope, /alice/);
});
