import { trace, context } from '@opentelemetry/api';

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
      // Print to stdout with a specific prefix so test_local.py can easily extract it
      console.log(`[OTEL_SPAN_JSON] ${JSON.stringify(jsonSpan)}`);
    }
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export function initializeTracing() {
  if (isOtelInitialized) return;

  // Set up the global OpenTelemetry provider
  // Since we register this globally, any internal ADK spans (e.g. tool calls, model calls)
  // will also automatically route to this provider and show up in the console.
  const spanProcessors: any[] = [
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

  const provider = new NodeTracerProvider({ spanProcessors });
  provider.register();
  tracerProvider = provider;

  isOtelInitialized = true;
}

const tracer = trace.getTracer('melchizedek-tracer');

export interface TraceMetadata {
  syndicateName: string;
  bindings?: Record<string, any>;
  input?: any;
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
  
  if (metadata.bindings) {
    span.setAttribute('syndicate.bindings', JSON.stringify(metadata.bindings));
  }
  if (metadata.input) {
    span.setAttribute('syndicate.input', JSON.stringify(metadata.input));
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let outputText = '';
  
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
          if (p.text && !p.thought) {
            outputText += p.text;
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
    span.end();
  }
}

// ── Per-model-request tracing ────────────────────────────────────────────────

export interface LlmCallMeta {
  /** Provider id, e.g. 'anthropic', 'openai', 'xai', 'ollama', 'gemini'. */
  provider: string;
  /** The model id as declared in the agent YAML (e.g. 'ollama/qwen3:8b'). */
  model: string;
}

const THINKING_EVENT_MAX_CHARS = 600;

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

  let inputTokens = 0;
  let outputTokens = 0;
  let thinkingTokens = 0;
  let thinkingPreview = '';

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
        span.setAttribute('llm.error_code', resp.errorCode);
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
    throw error;
  } finally {
    if (thinkingPreview) {
      span.addEvent('llm.thinking', { 'thinking.preview': thinkingPreview });
    }
    span.setAttribute('llm.tokens.input', inputTokens);
    span.setAttribute('llm.tokens.output', outputTokens);
    span.setAttribute('llm.tokens.thinking', thinkingTokens);
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
