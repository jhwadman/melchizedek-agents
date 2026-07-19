/**
 * lib/observability/supabaseSpanExporter.ts — optional OpenTelemetry sink
 * that persists model-request telemetry to Supabase.
 *
 * WHY this file exists:
 *   The console exporter in tracer.ts prints every span as an
 *   [OTEL_SPAN_JSON] line — good for a terminal, gone when it scrolls.
 *   Operators who want durable usage data (tokens per model, per provider,
 *   over time) can opt in with TELEMETRY_SUPABASE=true, and every
 *   `llm.request` and `Syndicate Execution:*` span is also inserted into
 *   the adk_telemetry table (schema: db/telemetry.sql, RLS: db/hardening.sql).
 *
 * DESIGN NOTES:
 *   - Fire-and-forget: an insert failure is logged once and never thrown
 *     into the tracing pipeline — telemetry must not break inference.
 *   - Only spans that carry usage are exported (name filter below); ADK's
 *     internal spans stay console-only to keep row volume sane.
 */

import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import core from '@opentelemetry/core';
const { ExportResultCode } = core;

import { hasSupabaseCredentials } from '../persistence/supabaseProvider.ts';

/** Row shape for the adk_telemetry table (db/telemetry.sql). */
interface TelemetryRow {
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
  span: Record<string, unknown>;
}

/** True when the operator has opted into the Supabase telemetry sink. */
export function telemetrySinkEnabled(): boolean {
  return process.env.TELEMETRY_SUPABASE === 'true' && hasSupabaseCredentials();
}

const EXPORTED_SPAN_NAMES = /^(llm\.request$|Syndicate Execution: )/;

export class SupabaseSpanExporter implements SpanExporter {
  /** Lazily created on first export so constructing the exporter is free
   *  and synchronous (NodeTracerProvider wants processors at construction). */
  private clientPromise: Promise<any> | undefined;
  private insertFailureLogged = false;
  private pendingInserts = new Set<Promise<unknown>>();

  private getClient(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = import('@supabase/supabase-js').then(
        ({ createClient }) =>
          createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
          ),
      );
    }
    return this.clientPromise;
  }

  export(spans: ReadableSpan[], resultCallback: (result: any) => void): void {
    const rows: TelemetryRow[] = spans
      .filter((span) => EXPORTED_SPAN_NAMES.test(span.name))
      .map((span) => this.toRow(span));

    if (rows.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS });
      return;
    }

    // Fire-and-forget: report success to the pipeline immediately; log the
    // first insert failure so a misconfigured table is visible without
    // spamming every span batch.
    const insert = this.getClient()
      .then((client) => client.from('adk_telemetry').insert(rows))
      .then(({ error }: { error: { message: string } | null }) => {
        if (error && !this.insertFailureLogged) {
          this.insertFailureLogged = true;
          console.warn(
            `[TELEMETRY] Supabase insert failed (${error.message}). ` +
              'Has db/telemetry.sql been applied? Telemetry rows are being dropped; ' +
              'console [OTEL_SPAN_JSON] output is unaffected.',
          );
        }
      })
      .catch((err: unknown) => {
        if (!this.insertFailureLogged) {
          this.insertFailureLogged = true;
          console.warn(
            `[TELEMETRY] Supabase sink error: ${err instanceof Error ? err.message : err}`,
          );
        }
      })
      .finally(() => this.pendingInserts.delete(insert));
    this.pendingInserts.add(insert);
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  /** Waits for in-flight inserts so short-lived scripts don't drop rows. */
  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.pendingInserts]);
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([...this.pendingInserts]);
  }

  /** Flatten a span into one adk_telemetry row. */
  private toRow(span: ReadableSpan): TelemetryRow {
    const attrs = span.attributes as Record<string, unknown>;
    const num = (key: string): number | null =>
      typeof attrs[key] === 'number' ? (attrs[key] as number) : null;
    const str = (key: string): string | null =>
      typeof attrs[key] === 'string' ? (attrs[key] as string) : null;

    // Root spans are named "Syndicate Execution: <name>"; llm.request spans
    // carry syndicate context only if the caller set syndicate.name.
    const syndicate =
      str('syndicate.name') ??
      (span.name.startsWith('Syndicate Execution: ')
        ? span.name.slice('Syndicate Execution: '.length)
        : null);

    return {
      ts: new Date(
        span.startTime[0] * 1000 + span.startTime[1] / 1e6,
      ).toISOString(),
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
      span_name: span.name,
      syndicate,
      agent: str('llm.agent'),
      provider: str('llm.provider'),
      model: str('llm.model'),
      input_tokens: num('llm.tokens.input') ?? num('syndicate.tokens.input'),
      output_tokens: num('llm.tokens.output') ?? num('syndicate.tokens.output'),
      thinking_tokens:
        num('llm.tokens.thinking') ?? num('syndicate.tokens.thinking'),
      latency_ms: span.duration[0] * 1000 + span.duration[1] / 1e6,
      span: {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        name: span.name,
        durationMs: span.duration[0] * 1000 + span.duration[1] / 1e6,
        attributes: attrs,
        events: span.events.map((e) => ({
          name: e.name,
          attributes: e.attributes ?? {},
        })),
        status: span.status,
      },
    };
  }
}
