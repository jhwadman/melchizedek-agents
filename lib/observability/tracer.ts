import { trace, context } from '@opentelemetry/api';
import { createRequire } from 'node:module';
import { TELEMETRY_SCHEMA_VERSION, engineVersion } from './lineage.ts';

import sdkNode from '@opentelemetry/sdk-trace-node';
const { NodeTracerProvider } = sdkNode;

import sdkBase from '@opentelemetry/sdk-trace-base';
const { SimpleSpanProcessor } = sdkBase;
// Types can be imported from the module:
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';

import core from '@opentelemetry/core';
const { ExportResultCode } = core;

import type { Event, LlmResponse } from '@google/adk';

import {
  SupabaseSpanExporter,
  telemetrySinkEnabled,
} from './supabaseSpanExporter.ts';

/**
 * Optional OTLP export for a live trace viewer (Phoenix, Langfuse, Grafana
 * Tempo, Jaeger — anything that speaks OTLP/HTTP). Set
 * OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://localhost:6006 for Phoenix) and
 * every span — ADK's included, so the viewer gets the waterfall — is also
 * sent there. OTEL_EXPORTER_OTLP_HEADERS is honoured by the exporter itself
 * (api keys); OTEL_SERVICE_NAME names the service (default "melchizedek").
 * Supabase stays the system of record; this is a viewer.
 */
export function otlpEndpoint(): string | undefined {
  const raw = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!raw) return undefined;
  return /\/v1\/traces\/?$/.test(raw) ? raw : `${raw.replace(/\/$/, '')}/v1/traces`;
}

function otlpProcessor(): any | undefined {
  const url = otlpEndpoint();
  if (!url) return undefined;
  try {
    // Synchronous load: NodeTracerProvider wants its processors at construction.
    const mod: any = createRequire(import.meta.url)('@opentelemetry/exporter-trace-otlp-http');
    const OTLPTraceExporter = mod.OTLPTraceExporter ?? mod.default?.OTLPTraceExporter;
    const { BatchSpanProcessor } = sdkBase;
    console.log(`[TELEMETRY] OTLP export enabled → ${url}`);
    return new BatchSpanProcessor(new OTLPTraceExporter({ url }));
  } catch (err: unknown) {
    console.warn(`[TELEMETRY] OTLP exporter unavailable (${err instanceof Error ? err.message : err}); spans not sent to ${url}`);
    return undefined;
  }
}

let isOtelInitialized = false;
let tracerProvider: InstanceType<typeof NodeTracerProvider> | undefined;
let telemetryExporter: SupabaseSpanExporter | undefined;

/**
 * Flushes buffered span processors (console is synchronous; the Supabase
 * batch sink is not). Call before process exit in short-lived scripts so
 * telemetry rows aren't dropped.
 */
export async function flushTracing(): Promise<void> {
  await tracerProvider?.forceFlush?.();
  await telemetryExporter?.forceFlush?.();
}

// ── In-process span listeners ────────────────────────────────────────────────
// Lets a script (e.g. scripts/demo_model_optionality.ts) read finished spans
// without scraping its own stdout for [OTEL_SPAN_JSON] lines.
const spanEndListeners = new Set<(span: ReadableSpan) => void>();

/** Subscribe to finished spans. Returns an unsubscribe function. */
export function onSpanEnd(
  listener: (span: ReadableSpan) => void,
): () => void {
  spanEndListeners.add(listener);
  return () => spanEndListeners.delete(listener);
}

// ADK's own spans (scope "gcp.vertex.agent": invocation, invoke_agent,
// call_llm, execute_tool) carry the FULL model request and response as
// attributes. They reach the in-process listeners — that is how per-agent
// attribution and the observatory work — but are not printed unless asked:
// on a server they would put every prompt into the log stream.
const ADK_SCOPE = 'gcp.vertex.agent';
const PRINT_ALL_SPANS = process.env.OTEL_CONSOLE_ALL_SPANS === 'true';
// OTEL_CONSOLE_SPANS=false silences the [OTEL_SPAN_JSON] lines entirely.
// The in-process listeners below still fire and the Supabase sink still
// records, so this costs no telemetry — it only unclutters a chat session.
// Read at export time rather than module load, so an entry point can set
// its own default in main() (syndicate_chat.ts defaults to silent) after
// loadEnv() has run and before the first span ends.
const printConsoleSpans = (): boolean => process.env.OTEL_CONSOLE_SPANS !== 'false';

function spanScopeName(span: ReadableSpan): string {
  const s = span as any;
  return s.instrumentationScope?.name ?? s.instrumentationLibrary?.name ?? '';
}

class JsonConsoleExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: any) => void): void {
    for (const span of spans) {
      for (const listener of spanEndListeners) {
        try {
          listener(span);
        } catch {
          /* a listener bug must not break the export pipeline */
        }
      }
      if (!printConsoleSpans()) continue;
      if (!PRINT_ALL_SPANS && spanScopeName(span) === ADK_SCOPE) continue;
      // Create a clean JSON representation of the span
      const jsonSpan = {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        durationMs: span.duration[0] * 1000 + span.duration[1] / 1000000,
        attributes: span.attributes,
        events: span.events.map(e => ({
          name: e.name,
          time: e.time,
          attributes: e.attributes || {}
        })),
        status: span.status,
      };
      // Print to stdout with a fixed prefix so a wrapper can extract spans from a transcript
      console.log(`[OTEL_SPAN_JSON] ${JSON.stringify(jsonSpan)}`);
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Span lineage (per-agent attribution) ─────────────────────────────────────
// ADK wraps every agent turn in an `invoke_agent <name>` span and every model
// call in a `call_llm` child of it; our llm.request span is a child of THAT.
// A span cannot read its parent's name through the OTEL API, so a processor
// records each span's name and parent at start, and llm.request walks up the
// chain to find the agent it belongs to. This is what fills the `agent`
// column of adk_telemetry — per-subagent cost and latency attribution — and
// what lets the observatory say which agent made which call.
const spanLineage = new Map<string, { name: string; parent?: string }>();
const SPAN_LINEAGE_CAP = 10_000;

/**
 * Per-trace accumulators, filled as child spans END and read by the root
 * span in its own finally: how much of a turn was model time vs tool time,
 * how many model calls it took, which models answered. The root turns
 * these into `syndicate.latency.model_ms` / `.tool_ms` / `syndicate.llm_calls`
 * / `syndicate.models`, so a p95 regression is attributable without
 * reassembling child spans at query time.
 */
interface TraceStats {
  modelMs: number;
  toolMs: number;
  llmCalls: number;
  models: Set<string>;
  startedAt: number;
}
const traceStats = new Map<string, TraceStats>();
const TRACE_STATS_TTL_MS = 60 * 60 * 1000;

function statsFor(traceId: string): TraceStats {
  let s = traceStats.get(traceId);
  if (!s) {
    s = { modelMs: 0, toolMs: 0, llmCalls: 0, models: new Set(), startedAt: Date.now() };
    traceStats.set(traceId, s);
    if (traceStats.size > 2_000) {
      const cutoff = Date.now() - TRACE_STATS_TTL_MS;
      for (const [id, st] of traceStats) if (st.startedAt < cutoff) traceStats.delete(id);
    }
  }
  return s;
}

/** Read-and-forget the stats for a finished trace. */
export function takeTraceStats(traceId: string): TraceStats | undefined {
  const s = traceStats.get(traceId);
  traceStats.delete(traceId);
  return s;
}

function spanDurationMs(span: ReadableSpan): number {
  return span.duration[0] * 1000 + span.duration[1] / 1e6;
}

class SpanLineageProcessor {
  onStart(span: any): void {
    const ctx = span.spanContext();
    const parent: string | undefined =
      span.parentSpanContext?.spanId ?? span.parentSpanId ?? undefined;
    spanLineage.set(ctx.spanId, { name: span.name, parent });
    // ADK's call_llm span (the one carrying the full request/response
    // payloads) learns its agent the same way llm.request does, so a
    // payload row can be attributed without re-walking the tree later.
    if (span.name === 'call_llm') {
      const agent = agentForSpan(parent);
      if (agent) span.setAttribute('llm.agent', agent);
    }
    if (spanLineage.size > SPAN_LINEAGE_CAP) {
      // A runaway process must never grow this without bound; parents end
      // after their children, so evicting the oldest entry is safe.
      const oldest = spanLineage.keys().next().value;
      if (oldest !== undefined) spanLineage.delete(oldest);
    }
  }
  onEnd(span: ReadableSpan): void {
    spanLineage.delete(span.spanContext().spanId);
    const traceId = span.spanContext().traceId;
    if (span.name === 'llm.request') {
      const s = statsFor(traceId);
      s.modelMs += spanDurationMs(span);
      s.llmCalls += 1;
      const model = span.attributes['llm.model'];
      if (typeof model === 'string' && model) s.models.add(model);
    } else if (span.name.startsWith('execute_tool ')) {
      statsFor(traceId).toolMs += spanDurationMs(span);
    }
  }
  shutdown(): Promise<void> { return Promise.resolve(); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
}

/** Name of the nearest enclosing ADK `invoke_agent` span, or null. */
export function agentForSpan(spanId: string | undefined): string | null {
  let cursor = spanId;
  for (let depth = 0; cursor && depth < 12; depth++) {
    const entry = spanLineage.get(cursor);
    if (!entry) return null;
    if (entry.name.startsWith('invoke_agent ')) return entry.name.slice('invoke_agent '.length);
    cursor = entry.parent;
  }
  return null;
}

/**
 * Hands the provider to ADK's private copy of @opentelemetry/api.
 *
 * WHY: @google/adk pins its own @opentelemetry/api (nested under its
 * node_modules) and creates its tracer at module-import time —
 * `trace.getTracer("gcp.vertex.agent")` in telemetry/tracing.js. That call
 * runs BEFORE any entrypoint can register a provider, so it binds to that
 * copy's ProxyTracerProvider, whose delegate is only ever set by a
 * `setGlobalTracerProvider` call made through the SAME copy. Ours goes
 * through the top-level copy; the global registration is shared (it lives
 * on a well-known Symbol), but the proxy's delegate is not. Result: every
 * ADK span — invoke_agent, call_llm, execute_tool — was a no-op, and
 * llm.request spans had no parent. Setting the delegate on ADK's proxy
 * fixes both: ADK spans now export, and the context manager (global,
 * shared) threads our llm.request spans under ADK's call_llm.
 *
 * `_proxyTracerProvider` is a private field of TraceAPI; this is the only
 * place that touches it, it is guarded, and a failure just means ADK spans
 * stay invisible — as they were.
 */
function adoptAdkTracerApi(provider: any): boolean {
  try {
    const requireHere = createRequire(import.meta.url);
    const adkEntry = requireHere.resolve('@google/adk');
    const adkApi = createRequire(adkEntry)('@opentelemetry/api');
    if (adkApi?.trace === trace) return true;
    const proxy = adkApi?.trace?._proxyTracerProvider;
    if (proxy && typeof proxy.setDelegate === 'function') {
      proxy.setDelegate(provider);
      return true;
    }
  } catch {
    /* ADK not installed or its api copy changed shape — see WHY above */
  }
  return false;
}

export function initializeTracing() {
  if (isOtelInitialized) return;

  // Set up the global OpenTelemetry provider
  // Since we register this globally, any internal ADK spans (e.g. tool calls, model calls)
  // will also automatically route to this provider and show up in the console.
  const spanProcessors: any[] = [
    new SpanLineageProcessor(),
    new SimpleSpanProcessor(new JsonConsoleExporter()),
  ];

  // Optional durable sink (TELEMETRY_SUPABASE=true + Supabase credentials):
  // llm.request and Syndicate Execution spans also land in adk_telemetry.
  // Batched so inserts never sit on the inference hot path; the exporter
  // creates its Supabase client lazily on first export.
  if (telemetrySinkEnabled()) {
    const { BatchSpanProcessor } = sdkBase;
    telemetryExporter = new SupabaseSpanExporter();
    spanProcessors.push(new BatchSpanProcessor(telemetryExporter));
    console.log('[TELEMETRY] Supabase sink enabled → adk_telemetry');
  }

  const otlp = otlpProcessor();
  if (otlp) spanProcessors.push(otlp);

  let resource: any;
  try {
    const res: any = createRequire(import.meta.url)('@opentelemetry/resources');
    const make = res.resourceFromAttributes ?? res.Resource?.default?.bind(res.Resource);
    resource = make ? make({ 'service.name': process.env.OTEL_SERVICE_NAME ?? 'melchizedek' }) : undefined;
  } catch {
    resource = undefined;
  }
  const provider = new NodeTracerProvider({ spanProcessors, ...(resource ? { resource } : {}) });
  provider.register();
  adoptAdkTracerApi(provider);
  tracerProvider = provider;

  isOtelInitialized = true;
}

const tracer = trace.getTracer('melchizedek-tracer');

/** Turn identity by trace id, so llm.request children can carry it too. */
const turnContexts = new Map<string, { sessionId?: string; userId?: string; taskId?: string }>();

export interface TraceMetadata {
  syndicateName: string;
  bindings?: Record<string, any>;
  input?: any;
  /**
   * The plan-dispatch resolution this turn runs under, recorded on the root
   * span as `syndicate.route*` attributes. Without it the chosen route was
   * only ever a console line, so routing accuracy could not be scored from
   * stored telemetry.
   */
  route?: {
    route: string;
    reason?: string;
    fellBack?: boolean;
    viaOverride?: boolean;
  };
  /**
   * Extra root-span attributes. The observatory tags eval traffic with
   * `eval.suite` / `eval.case` / `eval.variant` / `eval.trial` / `eval.run`
   * so post-deployment suites can exclude it from production traces.
   */
  attributes?: Record<string, string | number | boolean>;
  /** Receives the root span's ids as soon as it starts (before any child). */
  onSpanStart?: (ids: { traceId: string; spanId: string }) => void;
  /**
   * Identity of the turn. These are what make a stored turn joinable to
   * its session row (`adk_sessions.id` = app:user:session) and to the ADK
   * events of the same invocation; without them a trace and a session can
   * only be matched by timestamp and luck.
   */
  sessionId?: string;
  userId?: string;
  taskId?: string;
  /** 'delegate' | 'dispatch' | 'classify' | 'judge' — which kind of turn. */
  stage?: string;
  /** Provenance (lib/observability/lineage.ts): the resolved-config hash. */
  configHash?: string;
  /**
   * Called once, after the last event and before the span ends, to add
   * attributes only the consumer can know at that point — the A2A executor
   * reports whether the DELEGATE relay fallback fired, a fact decided from
   * the drained text and tool names. Runs inside the generator's finally,
   * so every event has been processed by the time it is asked.
   */
  onEnd?: () => Record<string, string | number | boolean | undefined>;
}

/**
 * Wraps an ADK `Runner.runAsync` stream with a root OpenTelemetry span.
 * Accumulates token counts, records variables (bindings) and the raw input/output.
 */
export async function* traceAgentRun(
  stream: AsyncIterableIterator<Event>,
  metadata: TraceMetadata
): AsyncGenerator<Event, void, void> {
  initializeTracing();

  const span = tracer.startSpan(`Syndicate Execution: ${metadata.syndicateName}`);
  turnContexts.set(span.spanContext().traceId, {
    sessionId: metadata.sessionId,
    userId: metadata.userId,
    taskId: metadata.taskId,
  });
  
  if (metadata.bindings) {
    span.setAttribute('syndicate.bindings', JSON.stringify(metadata.bindings));
  }
  if (metadata.input) {
    span.setAttribute('syndicate.input', JSON.stringify(metadata.input));
  }
  if (metadata.route) {
    span.setAttribute('syndicate.route', metadata.route.route);
    if (metadata.route.reason) span.setAttribute('syndicate.route.reason', metadata.route.reason);
    span.setAttribute('syndicate.route.fell_back', metadata.route.fellBack === true);
    span.setAttribute('syndicate.route.via_override', metadata.route.viaOverride === true);
  }
  if (metadata.sessionId) {
    span.setAttribute('session.id', metadata.sessionId);
    span.setAttribute('gen_ai.conversation.id', metadata.sessionId);
  }
  if (metadata.userId) span.setAttribute('user.id', metadata.userId);
  if (metadata.taskId) span.setAttribute('a2a.task_id', metadata.taskId);
  if (metadata.stage) span.setAttribute('syndicate.stage', metadata.stage);
  if (metadata.configHash) span.setAttribute('syndicate.config_hash', metadata.configHash);
  span.setAttribute('engine.version', engineVersion());
  span.setAttribute('telemetry.schema_version', TELEMETRY_SCHEMA_VERSION);
  for (const [key, value] of Object.entries(metadata.attributes ?? {})) {
    span.setAttribute(key, value);
  }
  metadata.onSpanStart?.({
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
  });

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let outputText = '';
  let invocationId = '';
  let respondingAgent = '';
  let errorCode = '';
  let errorMessage = '';
  
  const ctx = trace.setSpan(context.active(), span);

  try {
    const wrappedStream = {
      [Symbol.asyncIterator]() {
        return {
          async next() { return context.with(ctx, () => stream.next()); },
          async return(value?: any) { return stream.return ? context.with(ctx, () => stream.return!(value)) : { done: true, value }; },
          async throw(e?: any) { return stream.throw ? context.with(ctx, () => stream.throw!(e)) : Promise.reject(e); }
        };
      }
    };

    for await (const event of wrappedStream) {
      const ev = event as any;
      if (!invocationId && typeof ev.invocationId === 'string') invocationId = ev.invocationId;
      if ((ev.errorCode || ev.errorMessage) && ev.errorCode !== 'STOP') {
        errorCode = String(ev.errorCode ?? 'ERROR');
        errorMessage = String(ev.errorMessage ?? '');
      }
      if (event.usageMetadata) {
        // Aggregation caveat: a multi-turn run repeats the growing prompt on
        // every model call, so Math.max under-reports true billed input. The
        // per-call llm.request spans (traceLlmGeneration) carry the honest
        // per-request numbers; this root-span figure is the peak context size.
        if (event.usageMetadata.promptTokenCount) {
          totalInputTokens = Math.max(totalInputTokens, event.usageMetadata.promptTokenCount);
        }
        if (event.usageMetadata.candidatesTokenCount) {
          totalOutputTokens += event.usageMetadata.candidatesTokenCount;
        }
        if (event.usageMetadata.thoughtsTokenCount) {
          totalThinkingTokens += event.usageMetadata.thoughtsTokenCount;
        }
      }
      
      if (event.content && event.content.parts) {
        for (const part of event.content.parts) {
          const p = part as any;
          // Under SSE the reply streams as partials and is then repeated
          // whole on the final event. Count it once, from the final, or
          // syndicate.output records every answer twice.
          if (p.text && !p.thought && !ev.partial) {
            outputText += p.text;
            if (ev.author) respondingAgent = String(ev.author);
          }
          if (p.functionCall) {
            span.addEvent('ToolCall', {
              'tool.name': p.functionCall.name,
              'tool.args': JSON.stringify(p.functionCall.args || {})
            });
          }
          if (p.functionResponse) {
            let respData = p.functionResponse.response;
            if (typeof respData !== 'string') {
               respData = JSON.stringify(respData);
            }
            span.addEvent('ToolResponse', {
              'tool.name': p.functionResponse.name,
              'tool.data_gathered': respData
            });
          }
        }
      }

      yield event;
    }
  } catch (error: any) {
    span.recordException(error);
    throw error;
  } finally {
    span.setAttribute('syndicate.name', metadata.syndicateName);
    span.setAttribute('syndicate.tokens.input', totalInputTokens);
    span.setAttribute('syndicate.tokens.output', totalOutputTokens);
    span.setAttribute('syndicate.tokens.thinking', totalThinkingTokens);
    span.setAttribute('syndicate.output', outputText);
    if (invocationId) span.setAttribute('adk.invocation_id', invocationId);
    if (respondingAgent) span.setAttribute('syndicate.agent', respondingAgent);
    if (errorCode) {
      span.setAttribute('syndicate.error.code', errorCode);
      span.setAttribute('syndicate.error.message', errorMessage.slice(0, 4000));
    }
    turnContexts.delete(span.spanContext().traceId);
    const stats = takeTraceStats(span.spanContext().traceId);
    if (stats) {
      span.setAttribute('syndicate.latency.model_ms', Math.round(stats.modelMs));
      span.setAttribute('syndicate.latency.tool_ms', Math.round(stats.toolMs));
      span.setAttribute('syndicate.llm_calls', stats.llmCalls);
      span.setAttribute('syndicate.models', [...stats.models].sort().join(','));
    }
    try {
      for (const [key, value] of Object.entries(metadata.onEnd?.() ?? {})) {
        if (value !== undefined) span.setAttribute(key, value);
      }
    } catch {
      /* a consumer's onEnd must never break the span */
    }
    span.end();
  }
}

// ── Per-model-request tracing ────────────────────────────────────────────────

export interface LlmCallMeta {
  /** Provider id, e.g. 'anthropic', 'openai', 'xai', 'ollama', 'gemini'. */
  provider: string;
  /** The model id as declared in the agent YAML (e.g. 'ollama/qwen3:8b'). */
  model: string;
  /**
   * The full LlmRequest, attached to the span ONLY when the call errors.
   * ADK's own call_llm payload capture is lost on error — the consumer stops
   * pulling after the error event, so that span's end() (not in a finally)
   * never runs and the exporter never sees it. This span always ends, so an
   * errored call keeps its request + error body in adk_payloads regardless.
   */
  llmRequest?: unknown;
}

const THINKING_EVENT_MAX_CHARS = 600;
const ERROR_PAYLOAD_MAX_CHARS = 200_000;
const ERROR_MESSAGE_MAX_CHARS = 4_000;

/** JSON.stringify that never throws and never exceeds the cap. */
function safePayloadJson(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? String(value);
  } catch {
    json = String(value);
  }
  return json.length > ERROR_PAYLOAD_MAX_CHARS
    ? json.slice(0, ERROR_PAYLOAD_MAX_CHARS)
    : json;
}

/**
 * Providers throw errors whose message IS the API's JSON error body
 * (Gemini: {"error":{"code":503,"message":...,"status":...}}). Pull the
 * numeric code out so llm.error_code reads "503", not "THROWN".
 */
function refineErrorCode(code: string, message: string): string {
  try {
    const parsed = JSON.parse(message);
    if (parsed?.error?.code) return String(parsed.error.code);
  } catch {
    /* not a JSON body — keep the code we have */
  }
  return code;
}

/**
 * Wraps one adapter `generateContentAsync` invocation in an `llm.request`
 * span — one span per model call, for EVERY provider. Records provider,
 * model, input/output/thinking token counts, latency, and a truncated
 * thinking summary as a span event. Adapters call this around their own
 * generator; TracedGemini (lib/models/registry.ts) does the same for Gemini,
 * so per-request telemetry is uniform across the fleet.
 *
 * Adapters can decorate the active llm.request span with extra attributes
 * (e.g. llm.web_search.native) via setLlmSpanAttribute below.
 */
export async function* traceLlmGeneration(
  meta: LlmCallMeta,
  inner: AsyncGenerator<LlmResponse, void>,
): AsyncGenerator<LlmResponse, void> {
  initializeTracing();

  const span = tracer.startSpan('llm.request');
  span.setAttribute('llm.provider', meta.provider);
  span.setAttribute('llm.model', meta.model);
  // OpenTelemetry GenAI semantic conventions alongside the llm.* names, so
  // an OTLP backend (Phoenix, Langfuse, Tempo) reads these spans natively.
  span.setAttribute('gen_ai.system', meta.provider);
  span.setAttribute('gen_ai.request.model', meta.model);
  const agent = agentForSpan(span.spanContext().spanId);
  if (agent) {
    span.setAttribute('llm.agent', agent);
    span.setAttribute('gen_ai.agent.name', agent);
  }
  const turn = turnContexts.get(span.spanContext().traceId);
  if (turn) {
    if (turn.sessionId) {
      span.setAttribute('session.id', turn.sessionId);
      span.setAttribute('gen_ai.conversation.id', turn.sessionId);
    }
    if (turn.userId) span.setAttribute('user.id', turn.userId);
    if (turn.taskId) span.setAttribute('a2a.task_id', turn.taskId);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let thinkingPreview = '';
  let errorCode = '';
  let errorMessage = '';
  let errorResponse: unknown;

  const ctx = trace.setSpan(context.active(), span);

  try {
    while (true) {
      const { value: resp, done } = await context.with(ctx, () => inner.next());
      if (done) break;

      if (resp.usageMetadata) {
        // One llm.request span covers one API call; the last usage report
        // for that call is authoritative (streaming may repeat partials).
        inputTokens = resp.usageMetadata.promptTokenCount ?? inputTokens;
        outputTokens = resp.usageMetadata.candidatesTokenCount ?? outputTokens;
        thinkingTokens = resp.usageMetadata.thoughtsTokenCount ?? thinkingTokens;
      }
      if (resp.errorCode) {
        errorCode = String(resp.errorCode);
        errorMessage = String((resp as any).errorMessage ?? '');
        errorResponse = resp;
      }
      for (const part of resp.content?.parts ?? []) {
        const p = part as any;
        if (p.thought && p.text && thinkingPreview.length < THINKING_EVENT_MAX_CHARS) {
          thinkingPreview = (thinkingPreview + p.text).slice(0, THINKING_EVENT_MAX_CHARS);
        }
      }

      yield resp;
    }
  } catch (error: any) {
    span.recordException(error);
    // Gemini (and any adapter that throws instead of yielding an error
    // response) lands here; the message is often the raw API error body.
    errorMessage = error instanceof Error ? error.message : String(error);
    errorCode = refineErrorCode(errorCode || 'THROWN', errorMessage);
    errorResponse = { errorCode, errorMessage };
    throw error;
  } finally {
    if (thinkingPreview) {
      span.addEvent('llm.thinking', { 'thinking.preview': thinkingPreview });
    }
    if (errorCode) {
      span.setAttribute('llm.error_code', errorCode);
      span.setAttribute('llm.error_message', errorMessage.slice(0, ERROR_MESSAGE_MAX_CHARS));
      // Make this span a payload candidate (see supabaseSpanExporter's
      // isPayloadSpan): the request as sent and the error as received.
      if (meta.llmRequest !== undefined) {
        span.setAttribute('llm.payload.request', safePayloadJson(meta.llmRequest));
      }
      span.setAttribute('llm.payload.response', safePayloadJson(errorResponse ?? { errorCode, errorMessage }));
    }
    span.setAttribute('llm.tokens.input', inputTokens);
    span.setAttribute('llm.tokens.output', outputTokens);
    span.setAttribute('llm.tokens.thinking', thinkingTokens);
    span.setAttribute('gen_ai.usage.input_tokens', inputTokens);
    span.setAttribute('gen_ai.usage.output_tokens', outputTokens);
    // llm.latency_ms mirrors the span duration for the flat adk_telemetry row.
    span.end();
  }
}

/**
 * Sets an attribute on the currently active llm.request span, if any.
 * Used by adapters for per-request flags like llm.web_search.omitted.
 */
export function setLlmSpanAttribute(key: string, value: string | number | boolean): void {
  trace.getActiveSpan()?.setAttribute(key, value);
}
