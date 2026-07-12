import { trace, context } from '@opentelemetry/api';

import sdkNode from '@opentelemetry/sdk-trace-node';
const { NodeTracerProvider } = sdkNode;

import sdkBase from '@opentelemetry/sdk-trace-base';
const { SimpleSpanProcessor } = sdkBase;
// Types can be imported from the module:
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';

import core from '@opentelemetry/core';
const { ExportResultCode } = core;

import type { Event } from '@google/adk';

let isOtelInitialized = false;

class JsonConsoleExporter implements SpanExporter {
  export(spans: ReadableSpan[], resultCallback: (result: any) => void): void {
    for (const span of spans) {
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
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(new JsonConsoleExporter())]
  });
  provider.register();
  
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
        if (event.usageMetadata.promptTokenCount) {
          totalInputTokens = Math.max(totalInputTokens, event.usageMetadata.promptTokenCount);
        }
        if (event.usageMetadata.candidatesTokenCount) {
          totalOutputTokens += event.usageMetadata.candidatesTokenCount;
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
    span.setAttribute('syndicate.tokens.input', totalInputTokens);
    span.setAttribute('syndicate.tokens.output', totalOutputTokens);
    span.setAttribute('syndicate.output', outputText);
    span.end();
  }
}
