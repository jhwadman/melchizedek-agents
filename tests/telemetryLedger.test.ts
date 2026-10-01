/**
 * Observability-ledger invariants — fully offline, no API keys, no network.
 *
 * The ledger is only evidence if its rows are a faithful, deterministic
 * projection of the spans. These tests pin: the root-span → adk_turns
 * mapping, the input-text decoding, the payload policy (errors and
 * fallbacks always, a deterministic sample otherwise, off means off), the
 * exporter's wait-for-the-root buffering in both arrival orders, the
 * dead-letter spool on insert failure, and the provenance hashes.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SupabaseSpanExporter,
  isPayloadSpan,
  parseInputText,
  payloadDecision,
  payloadPolicyFromEnv,
  toPayloadRow,
  toTelemetryRow,
  toTurnRow,
  traceSampleValue,
  turnFacts,
} from '../lib/observability/supabaseSpanExporter.ts';
import { configDigest, inlineReferences, stableStringify } from '../lib/observability/lineage.ts';
import { serverToolEvents } from '../lib/observability/tracer.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';

// ── Span fixtures ────────────────────────────────────────────────────────────

function span(
  name: string,
  attributes: Record<string, unknown>,
  opts: { traceId?: string; spanId?: string; scope?: string; events?: any[]; statusCode?: number } = {},
): any {
  return {
    name,
    attributes,
    events: opts.events ?? [],
    status: { code: opts.statusCode ?? 0 },
    startTime: [1_787_400_000, 500_000_000],
    duration: [1, 250_000_000],
    instrumentationScope: { name: opts.scope ?? 'melchizedek-tracer' },
    spanContext: () => ({ traceId: opts.traceId ?? 'a'.repeat(32), spanId: opts.spanId ?? 'b'.repeat(16) }),
  };
}

function rootSpan(extra: Record<string, unknown> = {}, opts: Parameters<typeof span>[2] = {}): any {
  return span(
    'Syndicate Execution: Research Desk',
    {
      'syndicate.name': 'Research Desk',
      'syndicate.input': JSON.stringify([{ text: 'what is the vix at' }]),
      'syndicate.output': 'VIX 22.4.',
      'syndicate.stage': 'dispatch',
      'syndicate.route': 'TopicalGeneralist',
      'syndicate.route.reason': 'wants a single live figure',
      'syndicate.route.fell_back': false,
      'syndicate.route.via_override': false,
      'syndicate.agent': 'TopicalGeneralist',
      'syndicate.tokens.input': 1200,
      'syndicate.tokens.output': 40,
      'syndicate.tokens.thinking': 0,
      'syndicate.latency.model_ms': 900,
      'syndicate.latency.tool_ms': 300,
      'syndicate.llm_calls': 2,
      'syndicate.models': 'gemini-3.7-flash',
      'session.id': 'discord-123',
      'user.id': 'a2a-abc',
      'a2a.task_id': 'task-1',
      'adk.invocation_id': 'e-inv-1',
      'syndicate.config_hash': 'deadbeefcafef00d',
      'engine.version': '0.1.0+de25847',
      ...extra,
    },
    {
      events: [
        { name: 'ToolCall', attributes: { 'tool.name': 'lookup_metrics', 'tool.args': '{"tickers":"^VIX"}' } },
        { name: 'ToolResponse', attributes: { 'tool.name': 'lookup_metrics', 'tool.data_gathered': '{"^VIX":22.4}' } },
      ],
      ...opts,
    },
  );
}

function callLlmSpan(traceId: string, spanId: string): any {
  return span(
    'call_llm',
    {
      'gen_ai.system': 'gemini',
      'gen_ai.request.model': 'gemini-3.7-flash',
      'gcp.vertex.agent.invocation_id': 'e-inv-1',
      'gcp.vertex.agent.llm_request': JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      'gcp.vertex.agent.llm_response': JSON.stringify({ content: { parts: [{ text: 'VIX 22.4.' }] } }),
      'llm.agent': 'TopicalGeneralist',
    },
    { traceId, spanId, scope: 'gcp.vertex.agent' },
  );
}

// ── Mapping ──────────────────────────────────────────────────────────────────

test('parseInputText decodes A2A parts, plain strings, and non-JSON', () => {
  assert.strictEqual(parseInputText(JSON.stringify([{ text: 'a' }, { text: 'b' }])), 'a\nb');
  assert.strictEqual(parseInputText(JSON.stringify('plain')), 'plain');
  assert.strictEqual(parseInputText('not json at all'), 'not json at all');
  assert.strictEqual(parseInputText(undefined), '');
});

test('a root span projects into a complete adk_turns row', () => {
  const row = toTurnRow(rootSpan());
  assert.strictEqual(row.syndicate, 'Research Desk');
  assert.strictEqual(row.stage, 'dispatch');
  assert.strictEqual(row.input, 'what is the vix at');
  assert.strictEqual(row.output, 'VIX 22.4.');
  assert.strictEqual(row.route, 'TopicalGeneralist');
  assert.strictEqual(row.route_fell_back, false);
  assert.strictEqual(row.agent, 'TopicalGeneralist');
  assert.strictEqual(row.session_id, 'discord-123');
  assert.strictEqual(row.user_id, 'a2a-abc');
  assert.strictEqual(row.task_id, 'task-1');
  assert.strictEqual(row.invocation_id, 'e-inv-1');
  assert.strictEqual(row.config_hash, 'deadbeefcafef00d');
  assert.strictEqual(row.engine_version, '0.1.0+de25847');
  assert.strictEqual(row.latency_ms, 1250);
  assert.strictEqual(row.model_ms, 900);
  assert.strictEqual(row.tool_ms, 300);
  assert.strictEqual(row.llm_calls, 2);
  assert.deepStrictEqual(row.models, ['gemini-3.7-flash']);
  assert.strictEqual(row.tool_calls, 1);
  assert.deepStrictEqual(row.tool_events, [
    { name: 'ToolCall', tool: 'lookup_metrics', args: { tickers: '^VIX' } },
    { name: 'ToolResponse', tool: 'lookup_metrics', data: { '^VIX': 22.4 } },
  ]);
  assert.strictEqual(row.eval_run, null);
  assert.strictEqual(row.relay_fallback, false);
  assert.strictEqual(row.schema_version, 2);
  assert.strictEqual(row.ts, '2026-08-22T12:00:00.500Z');
});

test('server-side tool calls on a final event become ToolCall events the turn row counts', () => {
  const final = {
    customMetadata: {
      'responses.server_tool_calls': [
        { name: 'web_search', args: { type: 'search', query: 'NVDA close' }, status: 'completed', sources: ['https://a.example/x'] },
        { name: 'x_keyword_search', args: { query: 'NVDA since:2026-09-24', limit: '5' }, status: 'completed' },
      ],
    },
  };
  const events = serverToolEvents(final);
  assert.deepStrictEqual(events.map((e) => e.name), ['ToolCall', 'ToolResponse', 'ToolCall']);
  assert.strictEqual(events[0].attributes['tool.server_side'], true);

  // The projection is what adk_turns reads: a Grok turn with no functionCall
  // parts reports its two searches instead of tool_calls = 0.
  const row = toTurnRow(rootSpan({}, { events }));
  assert.strictEqual(row.tool_calls, 2);
  assert.deepStrictEqual(row.tool_events[0], { name: 'ToolCall', tool: 'web_search', args: { type: 'search', query: 'NVDA close' } });
  assert.deepStrictEqual(row.tool_events[1], { name: 'ToolResponse', tool: 'web_search', data: { sources: ['https://a.example/x'] } });

  // Partials repeat nothing; events without the key record nothing.
  assert.deepStrictEqual(serverToolEvents({ ...final, partial: true }), []);
  assert.deepStrictEqual(serverToolEvents({ content: { parts: [{ text: 'hi' }] } }), []);
});

test('eval tags and errors land in their columns', () => {
  const row = toTurnRow(rootSpan({ 'eval.run': 'r1', 'eval.suite': 's', 'eval.case': 'c', 'eval.variant': 'v', 'eval.trial': 2, 'syndicate.error.code': 'QUOTA', 'syndicate.error.message': 'boom' }));
  assert.strictEqual(row.eval_run, 'r1');
  assert.strictEqual(row.eval_trial, 2);
  assert.strictEqual(row.error_code, 'QUOTA');
  assert.strictEqual(row.error_message, 'boom');
});

test('turnFacts reads error and fallback off the root span', () => {
  assert.deepStrictEqual(turnFacts(rootSpan()), { error: false, fallback: false });
  assert.deepStrictEqual(turnFacts(rootSpan({ 'syndicate.error.code': 'X' })), { error: true, fallback: false });
  assert.deepStrictEqual(turnFacts(rootSpan({ 'syndicate.relay_fallback': true })), { error: false, fallback: true });
  assert.deepStrictEqual(turnFacts(rootSpan({ 'syndicate.route.fell_back': true })), { error: false, fallback: true });
  assert.deepStrictEqual(turnFacts(rootSpan({}, { statusCode: 2 })), { error: true, fallback: false });
});

// ── Policy ───────────────────────────────────────────────────────────────────

test('payload policy parses the env and defaults to a 10% sample, 30-day TTL', () => {
  assert.deepStrictEqual(payloadPolicyFromEnv({}), { mode: 'sample', sampleRate: 0.1, ttlDays: 30 });
  assert.deepStrictEqual(payloadPolicyFromEnv({ TELEMETRY_PAYLOADS: 'ALL', TELEMETRY_PAYLOAD_TTL_DAYS: '7' }), { mode: 'all', sampleRate: 0.1, ttlDays: 7 });
  assert.strictEqual(payloadPolicyFromEnv({ TELEMETRY_PAYLOADS: 'errors' }).mode, 'errors');
  assert.strictEqual(payloadPolicyFromEnv({ TELEMETRY_PAYLOADS: 'nonsense' }).mode, 'sample');
  assert.strictEqual(payloadPolicyFromEnv({ TELEMETRY_PAYLOAD_SAMPLE: '5' }).sampleRate, 1);
});

test('payload decisions: errors and fallbacks always, sample deterministic, off is off', () => {
  const sample = { mode: 'sample' as const, sampleRate: 0.1, ttlDays: 30 };
  const low = '00000000' + 'f'.repeat(24); // sample value 0 → kept
  const high = 'ffffffff' + '0'.repeat(24); // sample value ~1 → dropped
  assert.strictEqual(payloadDecision(sample, low, { error: false, fallback: false }), 'sample');
  assert.strictEqual(payloadDecision(sample, high, { error: false, fallback: false }), null);
  assert.strictEqual(payloadDecision(sample, high, { error: true, fallback: false }), 'error');
  assert.strictEqual(payloadDecision(sample, high, { error: false, fallback: true }), 'fallback');
  assert.strictEqual(payloadDecision({ ...sample, mode: 'errors' }, low, { error: false, fallback: false }), null);
  assert.strictEqual(payloadDecision({ ...sample, mode: 'all' }, high, { error: false, fallback: false }), 'all');
  assert.strictEqual(payloadDecision({ ...sample, mode: 'off' }, low, { error: true, fallback: true }), null);
  // Same trace, same answer, every time.
  assert.strictEqual(traceSampleValue(low), traceSampleValue(low));
  assert.ok(traceSampleValue(high) > 0.99);
});

test('a call_llm span maps to a payload row with parsed JSON and a TTL', () => {
  const row = toPayloadRow(callLlmSpan('t'.repeat(32), 'c'.repeat(16)), 'error', 30, { sessionId: 's1', invocationId: 'e-x' });
  assert.strictEqual(row.reason, 'error');
  assert.strictEqual(row.agent, 'TopicalGeneralist');
  assert.strictEqual(row.model, 'gemini-3.7-flash');
  assert.strictEqual(row.provider, 'gemini');
  assert.strictEqual(row.session_id, 's1');
  assert.strictEqual(row.invocation_id, 'e-inv-1', 'the span\'s own invocation id wins');
  assert.deepStrictEqual((row.request as any).contents[0].parts[0], { text: 'hi' });
  assert.ok(row.request_chars > 0 && row.response_chars > 0);
  assert.strictEqual(row.expires_at, '2026-09-21T12:00:00.500Z');
});

test('an errored llm.request span is a payload candidate; clean ones are not', () => {
  const traceId = 'f'.repeat(32);
  const errored = span(
    'llm.request',
    {
      'gen_ai.system': 'gemini',
      'gen_ai.request.model': 'gemini-3.7-flash',
      'llm.agent': 'Analyst',
      'llm.error_code': '503',
      'llm.payload.request': JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
      'llm.payload.response': JSON.stringify({ errorCode: '503', errorMessage: 'high demand' }),
    },
    { traceId, spanId: 'a'.repeat(16), scope: 'melchizedek' },
  );
  const clean = span(
    'llm.request',
    { 'gen_ai.system': 'gemini', 'gen_ai.request.model': 'gemini-3.7-flash' },
    { traceId, spanId: 'b'.repeat(16), scope: 'melchizedek' },
  );
  assert.strictEqual(isPayloadSpan(errored), true, 'errored llm.request carries its payload');
  assert.strictEqual(isPayloadSpan(clean), false, 'clean llm.request never duplicates call_llm');

  const row = toPayloadRow(errored, 'error', 30, { sessionId: 's1', invocationId: 'e-x' });
  assert.strictEqual(row.reason, 'error');
  assert.strictEqual(row.agent, 'Analyst');
  assert.strictEqual(row.provider, 'gemini');
  assert.strictEqual(row.invocation_id, 'e-x', 'falls back to the turn invocation id');
  assert.deepStrictEqual((row.request as any).contents[0].parts[0], { text: 'hi' });
  assert.strictEqual((row.response as any).errorCode, '503');
});

// ── Exporter buffering and dead-letter ───────────────────────────────────────

function fakeClient(captured: Array<[string, unknown[]]>, failTable?: string) {
  return {
    from: (table: string) => ({
      insert: async (rows: unknown[]) => {
        if (table === failTable) return { error: { message: 'relation does not exist' } };
        captured.push([table, rows]);
        return { error: null };
      },
    }),
  };
}

test('payloads wait for their root span, then follow its decision (children first)', async () => {
  const captured: Array<[string, unknown[]]> = [];
  const exporter = new SupabaseSpanExporter({ client: fakeClient(captured), policy: { mode: 'errors', sampleRate: 0, ttlDays: 30 }, deadLetterFile: '' });
  const traceId = 'e'.repeat(32);
  exporter.export([callLlmSpan(traceId, '1'.repeat(16)), callLlmSpan(traceId, '2'.repeat(16))], () => {});
  await exporter.forceFlush();
  assert.strictEqual(captured.length, 0, 'nothing lands before the root decides');
  exporter.export([rootSpan({ 'syndicate.error.code': 'QUOTA' }, { traceId })], () => {});
  await exporter.forceFlush();
  const tables = captured.map(([t]) => t).sort();
  assert.deepStrictEqual(tables, ['adk_payloads', 'adk_telemetry', 'adk_turns']);
  const payloads = captured.find(([t]) => t === 'adk_payloads')![1] as any[];
  assert.strictEqual(payloads.length, 2);
  assert.ok(payloads.every((r) => r.reason === 'error' && r.session_id === 'discord-123'));
  assert.strictEqual(exporter.stats.inserted.adk_turns, 1);
});

test('a clean turn under an errors-only policy drops its payloads; late children use the cached decision', async () => {
  const captured: Array<[string, unknown[]]> = [];
  const exporter = new SupabaseSpanExporter({ client: fakeClient(captured), policy: { mode: 'errors', sampleRate: 0, ttlDays: 30 }, deadLetterFile: '' });
  const traceId = 'f'.repeat(32);
  exporter.export([callLlmSpan(traceId, '1'.repeat(16)), rootSpan({}, { traceId })], () => {});
  exporter.export([callLlmSpan(traceId, '2'.repeat(16))], () => {}); // arrives after the root
  await exporter.forceFlush();
  assert.ok(!captured.some(([t]) => t === 'adk_payloads'));
  assert.strictEqual(exporter.stats.payloadsDropped, 2);
});

test('a sample policy keeps every payload of a sampled trace and none of an unsampled one', async () => {
  const captured: Array<[string, unknown[]]> = [];
  const exporter = new SupabaseSpanExporter({ client: fakeClient(captured), policy: { mode: 'sample', sampleRate: 0.5, ttlDays: 1 }, deadLetterFile: '' });
  const kept = '00000000' + 'a'.repeat(24);
  const dropped = 'ffffffff' + 'a'.repeat(24);
  exporter.export([callLlmSpan(kept, '1'.repeat(16)), rootSpan({}, { traceId: kept }), callLlmSpan(dropped, '2'.repeat(16)), rootSpan({}, { traceId: dropped, spanId: 'c'.repeat(16) })], () => {});
  await exporter.forceFlush();
  const payloads = captured.filter(([t]) => t === 'adk_payloads').flatMap(([, rows]) => rows as any[]);
  assert.strictEqual(payloads.length, 1);
  assert.strictEqual(payloads[0].trace_id, kept);
  assert.strictEqual(payloads[0].reason, 'sample');
});

test('an insert failure is spooled to the dead-letter file and counted, never thrown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-dl-'));
  const spool = join(dir, 'nested', 'deadletter.ndjson');
  const captured: Array<[string, unknown[]]> = [];
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (msg: string) => warned.push(String(msg));
  try {
    const exporter = new SupabaseSpanExporter({ client: fakeClient(captured, 'adk_turns'), policy: { mode: 'off', sampleRate: 0, ttlDays: 30 }, deadLetterFile: spool });
    exporter.export([rootSpan()], () => {});
    exporter.export([rootSpan({}, { spanId: 'd'.repeat(16) })], () => {});
    await exporter.forceFlush();
    assert.strictEqual(exporter.stats.failed.adk_turns, 2);
    assert.strictEqual(exporter.stats.deadLettered, 2);
    assert.strictEqual(exporter.stats.inserted.adk_telemetry, 2, 'the other table still lands');
    assert.ok(existsSync(spool));
    const lines = readFileSync(spool, 'utf-8').trim().split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(JSON.parse(lines[0]).table, 'adk_turns');
    assert.strictEqual(warned.length, 1, 'warned once per table, not per batch');
  } finally {
    console.warn = warn;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Provenance ───────────────────────────────────────────────────────────────

test('stableStringify is order-independent and drops undefined', () => {
  assert.strictEqual(stableStringify({ b: 1, a: { d: 2, c: 3 }, u: undefined }), '{"a":{"c":3,"d":2},"b":1}');
  assert.strictEqual(stableStringify([{ z: 1, y: 2 }]), '[{"y":2,"z":1}]');
});

test('configDigest is stable, inlines references, and changes when a nested prompt changes', () => {
  const router = loadSyndicate('research_brief.yaml');
  const load = (ref: string) => loadSyndicate(ref);
  const a = configDigest(router, load);
  const b = configDigest(loadSyndicate('research_brief.yaml'), load);
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  const inlined = inlineReferences(router, load) as any;
  const ref = inlined.subagents.find((s: any) => s.yaml_reference);
  assert.ok(ref.resolved_reference.orchestrator.instruction, 'nested syndicate is inlined');
  // A change two files down changes the parent's hash.
  const patched = configDigest(router, (r) => {
    const cfg = loadSyndicate(r);
    cfg.orchestrator.instruction += ' (patched)';
    return cfg;
  });
  assert.notStrictEqual(patched, a);
});

test('a failed call keeps its payload in adk_payloads only, never in the adk_telemetry row', () => {
  const failed = span('llm.request', {
    'llm.provider': 'gemini',
    'llm.model': 'gemini-3.1-flash-lite',
    'llm.error_code': '503',
    'llm.payload.request': '{"contents":"the whole prompt"}',
    'llm.payload.response': '{"error":"overloaded"}',
  });
  const row = toTelemetryRow(failed);
  const stored = JSON.stringify(row.span);
  assert.ok(!stored.includes('the whole prompt'), 'payload must not ride the telemetry row');
  assert.ok(stored.includes('llm.error_code'), 'the rest of the span is kept');
  const payload = toPayloadRow(failed, 'error', 30, undefined);
  assert.ok(payload && JSON.stringify(payload).includes('the whole prompt'), 'the payload tier still gets it');
});
