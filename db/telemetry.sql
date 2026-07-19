-- ============================================================
-- Melchizedek — Optional Telemetry Sink (TELEMETRY_SUPABASE=true)
-- Paste into the Supabase SQL Editor and run once per project,
-- THEN re-run db/hardening.sql (it locks this table down too).
-- ============================================================
--
-- WHY THIS EXISTS
-- Every model request emits an OpenTelemetry `llm.request` span (provider,
-- model, input/output/thinking tokens, latency), and every syndicate run a
-- root `Syndicate Execution:` span. By default those print to the console
-- as [OTEL_SPAN_JSON] lines and are gone when the terminal scrolls. With
-- TELEMETRY_SUPABASE=true (and Supabase credentials set), the framework
-- also inserts them here — durable usage data you can query: tokens per
-- provider per day, latency percentiles per model, cost attribution.
--
-- This table is OPTIONAL. Nothing in the framework requires it; if the
-- table is missing while the sink is enabled, inserts fail with a single
-- console warning and inference is unaffected.
--
-- Writes go through the service_role key (lib/observability/
-- supabaseSpanExporter.ts). The anon/authenticated API paths are closed by
-- db/hardening.sql — re-run it after creating this table.

CREATE TABLE adk_telemetry (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  span_name       TEXT NOT NULL,          -- 'llm.request' | 'Syndicate Execution: <name>'
  syndicate       TEXT,                   -- syndicate name, when known
  agent           TEXT,                   -- reserved for per-agent attribution
  provider        TEXT,                   -- 'gemini' | 'anthropic' | 'openai' | 'xai' | 'ollama'
  model           TEXT,                   -- model id as declared in YAML
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  thinking_tokens INTEGER,
  latency_ms      DOUBLE PRECISION,
  span            JSONB NOT NULL          -- full span (attributes, events, status)
);

CREATE INDEX idx_adk_telemetry_ts    ON adk_telemetry (ts DESC);
CREATE INDEX idx_adk_telemetry_trace ON adk_telemetry (trace_id);
