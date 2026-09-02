/**
 * lib/observability/supabaseSpanExporter.ts — the observability ledger sink.
 *
 * WHY this file exists:
 *   The console exporter in tracer.ts prints every span as an
 *   [OTEL_SPAN_JSON] line — good for a terminal, gone when it scrolls. With
 *   TELEMETRY_SUPABASE=true (and Supabase credentials) every turn and every
 *   model call is also written to Supabase, in three tiers with three
 *   lifetimes (schema: db/telemetry.sql, lockdown: db/hardening.sql):
 *
 *     adk_turns      one row per turn — the system of record: input, output,
 *                    route, agent, errors, tokens, model-vs-tool time, the
 *                    tool calls WITH their responses, the ids that join it to
 *                    the session (session_id, invocation_id) and the task,
 *                    and provenance (config_hash, engine_version).
 *     adk_telemetry  one row per span — llm.request and root spans, raw.
 *     adk_payloads   full request/response per model call, captured by
 *                    POLICY and expiring. ADK's own call_llm spans carry the
 *                    assembled prompt and raw response; they are 10-100x a
 *                    turn row, so: errors and fallbacks always, a
 *                    deterministic sample of the rest, 30-day TTL.
 *
 * DESIGN NOTES:
 *   - Never on the hot path: inserts are fire-and-forget behind a
 *     BatchSpanProcessor; a failure is logged once per table and the rows
 *     are spooled to a dead-letter file (OUTPUTS_DIR/telemetry-deadletter.ndjson)
 *     so a sink outage loses nothing silently. `npm run telemetry:stats`
 *     shows what landed; `telemetry:replay` re-sends the spool.
 *   - Payload decisions need the TURN's outcome (error? fallback?), which is
 *     only known when the root span ends — after its call_llm children. So
 *     call_llm spans wait in a per-trace buffer until their root arrives,
 *     then the decision is applied to all of them at once. Children that
 *     arrive after the root (a later batch) find the decision cached.
 *   - Sampling is deterministic in the trace id: a trace keeps all of its
 *     payloads or none, and a re-run of the same policy keeps the same set.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import core from '@opentelemetry/core';
const { ExportResultCode } = core;

import { hasSupabaseCredentials } from '../persistence/supabaseProvider.ts';
import { TELEMETRY_SCHEMA_VERSION } from './lineage.ts';

// ── Row shapes ───────────────────────────────────────────────────────────────

/** Row shape for adk_telemetry (raw spans). */
export interface TelemetryRow {
  ts: string;
  trace_id: string;
  span_id: string;
  span_name: string;
  syndicate: string | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  latency_ms: number;
  session_id: string | null;
  user_id: string | null;
  task_id: string | null;
  invocation_id: string | null;
  schema_version: number;
  span: Record<string, unknown>;
}

/** Row shape for adk_turns (the system of record). */
export interface TurnRow {
  ts: string;
  trace_id: string;
  span_id: string;
  session_id: string | null;
  user_id: string | null;
  task_id: string | null;
  invocation_id: string | null;
  /** Where the turn came from, when the caller named it (X-Surface-* headers). */
  surface: string | null;
  surface_guild: string | null;
  surface_channel: string | null;
  surface_user: string | null;
  syndicate: string;
  stage: string;
  agent: string | null;
  route: string | null;
  route_reason: string | null;
  route_fell_back: boolean | null;
  route_via_override: boolean | null;
  relay_fallback: boolean;
  input: string;
  output: string;
  error_code: string | null;
  error_message: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  thinking_tokens: number | null;
  latency_ms: number;
  model_ms: number | null;
  tool_ms: number | null;
  llm_calls: number | null;
  tool_calls: number;
  models: string[];
  tool_events: Array<Record<string, unknown>>;
  config_hash: string | null;
  engine_version: string | null;
  eval_run: string | null;
  eval_suite: string | null;
  eval_case: string | null;
  eval_variant: string | null;
  eval_trial: number | null;
  attributes: Record<string, unknown>;
  schema_version: number;
}

export type PayloadReason = 'error' | 'fallback' | 'sample' | 'all';

/** Row shape for adk_payloads. */
export interface PayloadRow {
  ts: string;
  trace_id: string;
  span_id: string;
  session_id: string | null;
  invocation_id: string | null;
  agent: string | null;
  provider: string | null;
  model: string | null;
  reason: PayloadReason;
  request: unknown;
  response: unknown;
  request_chars: number;
  response_chars: number;
  expires_at: string;
  schema_version: number;
}

// ── Policy ───────────────────────────────────────────────────────────────────

export type PayloadMode = 'off' | 'errors' | 'sample' | 'all';

export interface PayloadPolicy {
  mode: PayloadMode;
  /** Fraction of non-error, non-fallback traces kept in 'sample' mode. */
  sampleRate: number;
  ttlDays: number;
}

/**
 * TELEMETRY_PAYLOADS: off | errors | sample (default) | all
 * TELEMETRY_PAYLOAD_SAMPLE: 0..1, default 0.10
 * TELEMETRY_PAYLOAD_TTL_DAYS: default 30
 */
export function payloadPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): PayloadPolicy {
  const raw = (env.TELEMETRY_PAYLOADS ?? 'sample').trim().toLowerCase();
  const mode: PayloadMode = raw === 'off' || raw === 'errors' || raw === 'all' ? raw : 'sample';
  const rate = Number(env.TELEMETRY_PAYLOAD_SAMPLE ?? '0.10');
  const ttl = Number(env.TELEMETRY_PAYLOAD_TTL_DAYS ?? '30');
  return {
    mode,
    sampleRate: Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0.1,
    ttlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : 30,
  };
}

/** Deterministic 0..1 value from a trace id (first 8 hex chars). */
export function traceSampleValue(traceId: string): number {
  const head = parseInt(traceId.slice(0, 8), 16);
  return Number.isFinite(head) ? head / 0x100000000 : 1;
}

export interface TurnFacts {
  error: boolean;
  fallback: boolean;
}

/** Which payloads of a turn to keep, given the policy and the turn's outcome. */
export function payloadDecision(
  policy: PayloadPolicy,
  traceId: string,
  facts: TurnFacts,
): PayloadReason | null {
  if (policy.mode === 'off') return null;
  if (facts.error) return 'error';
  if (facts.fallback) return 'fallback';
  if (policy.mode === 'errors') return null;
  if (policy.mode === 'all') return 'all';
  return traceSampleValue(traceId) < policy.sampleRate ? 'sample' : null;
}

// ── Span → row mapping (pure; tested offline) ───────────────────────────────

const ROOT_PREFIX = 'Syndicate Execution: ';
const EXPORTED_SPAN_NAMES = /^(llm\.request$|Syndicate Execution: )/;
const ADK_SCOPE = 'gcp.vertex.agent';

function attrsOf(span: ReadableSpan): Record<string, unknown> {
  return span.attributes as Record<string, unknown>;
}
function num(attrs: Record<string, unknown>, key: string): number | null {
  return typeof attrs[key] === 'number' ? (attrs[key] as number) : null;
}
function str(attrs: Record<string, unknown>, key: string): string | null {
  return typeof attrs[key] === 'string' && (attrs[key] as string) !== '' ? (attrs[key] as string) : null;
}
function bool(attrs: Record<string, unknown>, key: string): boolean | null {
  return typeof attrs[key] === 'boolean' ? (attrs[key] as boolean) : null;
}
function spanTs(span: ReadableSpan): string {
  return new Date(span.startTime[0] * 1000 + span.startTime[1] / 1e6).toISOString();
}
function durationMs(span: ReadableSpan): number {
  return span.duration[0] * 1000 + span.duration[1] / 1e6;
}
function scopeName(span: ReadableSpan): string {
  const s = span as any;
  return s.instrumentationScope?.name ?? s.instrumentationLibrary?.name ?? '';
}
export function isRootSpan(span: ReadableSpan): boolean {
  return span.name.startsWith(ROOT_PREFIX);
}
export function isPayloadSpan(span: ReadableSpan): boolean {
  if (span.name === 'call_llm' && scopeName(span) === ADK_SCOPE) return true;
  // Errored calls: ADK's call_llm span is unreliable on error (its end() is
  // skipped when the consumer stops at the error event, and traceCallLlm
  // never ran for a thrown error), so traceLlmGeneration attaches the
  // request + error body to its own llm.request span instead — but only on
  // error, so clean turns never produce a second payload row.
  return span.name === 'llm.request' && !!attrsOf(span)['llm.payload.response'];
}

/** `syndicate.input` is JSON.stringify of either a string or A2A parts. */
export function parseInputText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (typeof raw !== 'string') return String(raw);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (Array.isArray(data)) {
    return data
      .map((p) => (p && typeof p === 'object' ? String((p as any).text ?? '') : String(p)))
      .join('\n');
  }
  return typeof data === 'string' ? data : JSON.stringify(data);
}

function parseLoose(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function syndicateOf(span: ReadableSpan): string | null {
  const attrs = attrsOf(span);
  return str(attrs, 'syndicate.name') ?? (isRootSpan(span) ? span.name.slice(ROOT_PREFIX.length) : null);
}

function spanJson(span: ReadableSpan): Record<string, unknown> {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    name: span.name,
    durationMs: durationMs(span),
    attributes: attrsOf(span),
    events: span.events.map((e) => ({ name: e.name, attributes: e.attributes ?? {} })),
    status: span.status,
  };
}

/** Flatten an llm.request or root span into one adk_telemetry row. */
export function toTelemetryRow(span: ReadableSpan): TelemetryRow {
  const attrs = attrsOf(span);
  return {
    ts: spanTs(span),
    trace_id: span.spanContext().traceId,
    span_id: span.spanContext().spanId,
    span_name: span.name,
    syndicate: syndicateOf(span),
    agent: str(attrs, 'llm.agent') ?? str(attrs, 'syndicate.agent'),
    provider: str(attrs, 'llm.provider'),
    model: str(attrs, 'llm.model'),
    input_tokens: num(attrs, 'llm.tokens.input') ?? num(attrs, 'syndicate.tokens.input'),
    output_tokens: num(attrs, 'llm.tokens.output') ?? num(attrs, 'syndicate.tokens.output'),
    thinking_tokens: num(attrs, 'llm.tokens.thinking') ?? num(attrs, 'syndicate.tokens.thinking'),
    latency_ms: durationMs(span),
    session_id: str(attrs, 'session.id'),
    user_id: str(attrs, 'user.id'),
    task_id: str(attrs, 'a2a.task_id'),
    invocation_id: str(attrs, 'adk.invocation_id'),
    schema_version: TELEMETRY_SCHEMA_VERSION,
    span: spanJson(span),
  };
}

/** Project a root span into the adk_turns system-of-record row. */
export function toTurnRow(span: ReadableSpan): TurnRow {
  const attrs = attrsOf(span);
  const toolEvents = span.events
    .filter((e) => e.name === 'ToolCall' || e.name === 'ToolResponse')
    .map((e) => {
      const a = (e.attributes ?? {}) as Record<string, unknown>;
      return e.name === 'ToolCall'
        ? { name: 'ToolCall', tool: a['tool.name'] ?? null, args: parseLoose(a['tool.args']) }
        : { name: 'ToolResponse', tool: a['tool.name'] ?? null, data: parseLoose(a['tool.data_gathered']) };
    });
  const models = (str(attrs, 'syndicate.models') ?? '').split(',').filter(Boolean);
  const evalTrial = attrs['eval.trial'];
  return {
    ts: spanTs(span),
    trace_id: span.spanContext().traceId,
    span_id: span.spanContext().spanId,
    session_id: str(attrs, 'session.id'),
    user_id: str(attrs, 'user.id'),
    task_id: str(attrs, 'a2a.task_id'),
    invocation_id: str(attrs, 'adk.invocation_id'),
    surface: str(attrs, 'surface.name'),
    surface_guild: str(attrs, 'surface.guild'),
    surface_channel: str(attrs, 'surface.channel'),
    surface_user: str(attrs, 'surface.user'),
    syndicate: syndicateOf(span) ?? 'unknown',
    stage: str(attrs, 'syndicate.stage') ?? 'delegate',
    agent: str(attrs, 'syndicate.agent'),
    route: str(attrs, 'syndicate.route'),
    route_reason: str(attrs, 'syndicate.route.reason'),
    route_fell_back: bool(attrs, 'syndicate.route.fell_back'),
    route_via_override: bool(attrs, 'syndicate.route.via_override'),
    relay_fallback: bool(attrs, 'syndicate.relay_fallback') ?? false,
    input: parseInputText(attrs['syndicate.input']),
    output: str(attrs, 'syndicate.output') ?? '',
    error_code: str(attrs, 'syndicate.error.code'),
    error_message: str(attrs, 'syndicate.error.message'),
    input_tokens: num(attrs, 'syndicate.tokens.input'),
    output_tokens: num(attrs, 'syndicate.tokens.output'),
    thinking_tokens: num(attrs, 'syndicate.tokens.thinking'),
    latency_ms: durationMs(span),
    model_ms: num(attrs, 'syndicate.latency.model_ms'),
    tool_ms: num(attrs, 'syndicate.latency.tool_ms'),
    llm_calls: num(attrs, 'syndicate.llm_calls'),
    tool_calls: toolEvents.filter((e) => e.name === 'ToolCall').length,
    models,
    tool_events: toolEvents,
    config_hash: str(attrs, 'syndicate.config_hash'),
    engine_version: str(attrs, 'engine.version'),
    eval_run: str(attrs, 'eval.run'),
    eval_suite: str(attrs, 'eval.suite'),
    eval_case: str(attrs, 'eval.case'),
    eval_variant: str(attrs, 'eval.variant'),
    eval_trial: typeof evalTrial === 'number' ? evalTrial : evalTrial ? Number(evalTrial) || null : null,
    attributes: attrs,
    schema_version: TELEMETRY_SCHEMA_VERSION,
  };
}

/** The facts a payload decision needs, read off a root span. */
export function turnFacts(span: ReadableSpan): TurnFacts {
  const attrs = attrsOf(span);
  const statusError = (span.status as any)?.code === 2; // SpanStatusCode.ERROR
  return {
    error: !!str(attrs, 'syndicate.error.code') || statusError,
    fallback: bool(attrs, 'syndicate.relay_fallback') === true || bool(attrs, 'syndicate.route.fell_back') === true,
  };
}

/** Map an ADK call_llm span into an adk_payloads row. */
export function toPayloadRow(
  span: ReadableSpan,
  reason: PayloadReason,
  ttlDays: number,
  turn: { sessionId: string | null; invocationId: string | null } | undefined,
): PayloadRow {
  const attrs = attrsOf(span);
  const request =
    str(attrs, 'gcp.vertex.agent.llm_request') ?? str(attrs, 'llm.payload.request') ?? '';
  const response =
    str(attrs, 'gcp.vertex.agent.llm_response') ?? str(attrs, 'llm.payload.response') ?? '';
  const started = span.startTime[0] * 1000 + span.startTime[1] / 1e6;
  return {
    ts: new Date(started).toISOString(),
    trace_id: span.spanContext().traceId,
    span_id: span.spanContext().spanId,
    session_id: turn?.sessionId ?? null,
    invocation_id: str(attrs, 'gcp.vertex.agent.invocation_id') ?? turn?.invocationId ?? null,
    agent: str(attrs, 'llm.agent') ?? str(attrs, 'gen_ai.agent.name'),
    provider: str(attrs, 'gen_ai.system'),
    model: str(attrs, 'gen_ai.request.model'),
    reason,
    request: parseLoose(request),
    response: parseLoose(response),
    request_chars: request.length,
    response_chars: response.length,
    expires_at: new Date(started + ttlDays * 86_400_000).toISOString(),
    schema_version: TELEMETRY_SCHEMA_VERSION,
  };
}

// ── The exporter ─────────────────────────────────────────────────────────────

/** True when the operator has opted into the Supabase ledger. */
export function telemetrySinkEnabled(): boolean {
  return process.env.TELEMETRY_SUPABASE === 'true' && hasSupabaseCredentials();
}

export function deadLetterPath(): string {
  return join(process.env.OUTPUTS_DIR ?? join(process.cwd(), 'outputs'), 'telemetry-deadletter.ndjson');
}

export interface ExportStats {
  inserted: Record<string, number>;
  failed: Record<string, number>;
  deadLettered: number;
  payloadsDropped: number;
}

interface SupabaseLikeClient {
  from(table: string): { insert(rows: unknown[]): PromiseLike<{ error: { message: string } | null }> };
}

export interface ExporterOptions {
  /** Injected client (tests); default: lazily created supabase-js client. */
  client?: SupabaseLikeClient;
  policy?: PayloadPolicy;
  /** Where failed batches are spooled; '' disables the spool. */
  deadLetterFile?: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const DECISION_TTL_MS = 30 * 60 * 1000;
const PENDING_CAP = 5_000;

export class SupabaseSpanExporter implements SpanExporter {
  private clientPromise: Promise<SupabaseLikeClient> | undefined;
  private readonly policy: PayloadPolicy;
  private readonly deadLetterFile: string;
  private readonly failureLogged = new Set<string>();
  private readonly pendingInserts = new Set<Promise<unknown>>();
  /** call_llm spans waiting for their root span's outcome, by trace id. */
  private readonly pendingPayloads = new Map<string, { at: number; spans: ReadableSpan[] }>();
  /** Decisions already taken for a trace, for children arriving late. */
  private readonly decisions = new Map<
    string,
    { at: number; reason: PayloadReason | null; sessionId: string | null; invocationId: string | null }
  >();
  private pendingCount = 0;
  readonly stats: ExportStats = { inserted: {}, failed: {}, deadLettered: 0, payloadsDropped: 0 };

  constructor(options: ExporterOptions = {}) {
    this.policy = options.policy ?? payloadPolicyFromEnv();
    this.deadLetterFile = options.deadLetterFile ?? deadLetterPath();
    if (options.client) this.clientPromise = Promise.resolve(options.client);
  }

  private getClient(): Promise<SupabaseLikeClient> {
    if (!this.clientPromise) {
      this.clientPromise = import('@supabase/supabase-js').then(
        ({ createClient }) =>
          createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!) as unknown as SupabaseLikeClient,
      );
    }
    return this.clientPromise;
  }

  export(spans: ReadableSpan[], resultCallback: (result: any) => void): void {
    const telemetryRows: TelemetryRow[] = [];
    const turnRows: TurnRow[] = [];
    const payloadRows: PayloadRow[] = [];

    for (const span of spans) {
      if (EXPORTED_SPAN_NAMES.test(span.name)) telemetryRows.push(toTelemetryRow(span));

      if (isRootSpan(span)) {
        const turn = toTurnRow(span);
        turnRows.push(turn);
        const traceId = span.spanContext().traceId;
        const reason = payloadDecision(this.policy, traceId, turnFacts(span));
        const ctx = { sessionId: turn.session_id, invocationId: turn.invocation_id };
        this.decisions.set(traceId, { at: Date.now(), reason, ...ctx });
        const waiting = this.pendingPayloads.get(traceId);
        if (waiting) {
          this.pendingPayloads.delete(traceId);
          this.pendingCount -= waiting.spans.length;
          if (reason) {
            for (const child of waiting.spans) payloadRows.push(toPayloadRow(child, reason, this.policy.ttlDays, ctx));
          } else {
            this.stats.payloadsDropped += waiting.spans.length;
          }
        }
        continue;
      }

      if (this.policy.mode !== 'off' && isPayloadSpan(span)) {
        const traceId = span.spanContext().traceId;
        const decided = this.decisions.get(traceId);
        if (decided) {
          if (decided.reason) payloadRows.push(toPayloadRow(span, decided.reason, this.policy.ttlDays, decided));
          else this.stats.payloadsDropped += 1;
        } else if (this.pendingCount < PENDING_CAP) {
          const entry = this.pendingPayloads.get(traceId) ?? { at: Date.now(), spans: [] };
          entry.spans.push(span);
          this.pendingPayloads.set(traceId, entry);
          this.pendingCount += 1;
        } else {
          this.stats.payloadsDropped += 1;
        }
      }
    }

    this.pruneBuffers();
    if (telemetryRows.length) this.insert('adk_telemetry', telemetryRows);
    if (turnRows.length) this.insert('adk_turns', turnRows);
    if (payloadRows.length) this.insert('adk_payloads', payloadRows);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  private pruneBuffers(): void {
    const now = Date.now();
    for (const [traceId, entry] of this.pendingPayloads) {
      if (now - entry.at > PENDING_TTL_MS) {
        this.pendingPayloads.delete(traceId);
        this.pendingCount -= entry.spans.length;
        this.stats.payloadsDropped += entry.spans.length;
      }
    }
    for (const [traceId, d] of this.decisions) {
      if (now - d.at > DECISION_TTL_MS) this.decisions.delete(traceId);
    }
  }

  /** Fire-and-forget insert; failures are logged once per table and spooled. */
  private insert(table: string, rows: unknown[]): void {
    const attempt = this.getClient()
      .then((client) => client.from(table).insert(rows))
      .then(({ error }) => {
        if (error) this.onFailure(table, rows, error.message);
        else this.stats.inserted[table] = (this.stats.inserted[table] ?? 0) + rows.length;
      })
      .catch((err: unknown) => this.onFailure(table, rows, err instanceof Error ? err.message : String(err)))
      .finally(() => this.pendingInserts.delete(attempt));
    this.pendingInserts.add(attempt);
  }

  private onFailure(table: string, rows: unknown[], message: string): void {
    this.stats.failed[table] = (this.stats.failed[table] ?? 0) + rows.length;
    if (!this.failureLogged.has(table)) {
      this.failureLogged.add(table);
      console.warn(
        `[TELEMETRY] insert into ${table} failed (${message}). ` +
          `Has db/telemetry.sql been applied? Rows are spooled to ${this.deadLetterFile || '(spool disabled)'}; ` +
          'console [OTEL_SPAN_JSON] output is unaffected.',
      );
    }
    if (!this.deadLetterFile) return;
    try {
      mkdirSync(join(this.deadLetterFile, '..'), { recursive: true });
      appendFileSync(
        this.deadLetterFile,
        `${JSON.stringify({ ts: new Date().toISOString(), table, error: message, rows })}\n`,
      );
      this.stats.deadLettered += rows.length;
    } catch {
      /* the spool is best-effort; the warning above already fired */
    }
  }

  /** Waits for in-flight inserts so short-lived scripts don't drop rows. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.pendingInserts]);
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.pendingInserts]);
  }
}
