-- ============================================================
-- Melchizedek — The observability ledger (TELEMETRY_SUPABASE=true)
-- Idempotent: safe to run on a fresh project AND on one that already has
-- the v1 adk_telemetry table. Run it in the Supabase SQL Editor (or with
-- psql via SUPABASE_DB_URL), THEN re-run db/hardening.sql — it locks these
-- tables down too.
-- ============================================================
--
-- WHY THREE TABLES
-- The engine emits OpenTelemetry spans for every turn and every model
-- call (lib/observability/tracer.ts). By default they print to the console
-- and are gone. With the sink on, lib/observability/supabaseSpanExporter.ts
-- writes them here in three tiers with three lifetimes:
--
--   adk_turns      ONE ROW PER TURN — the system of record. Input, output,
--                  the responding agent, the plan-dispatch route and how it
--                  was decided, errors, tokens, latency split into model vs
--                  tool time, the tool calls WITH their full responses
--                  (the grounding evidence), and the identity that joins the
--                  row to everything else: trace_id, session_id, user_id,
--                  task_id, invocation_id. Plus provenance: config_hash (the
--                  resolved syndicate that ran) and engine_version. Kept
--                  indefinitely; full-text searchable. Eval runs land here
--                  too, tagged eval_* so production views exclude them.
--   adk_telemetry  ONE ROW PER SPAN — the raw llm.request and root spans as
--                  before (v1 shape, now with the identity columns). Per-call
--                  tokens, latency and the agent that made the call. Small;
--                  kept indefinitely.
--   adk_payloads   FULL REQUEST/RESPONSE PER MODEL CALL — the assembled
--                  prompt (system instruction, history, tool schemas) and the
--                  raw response. 10-100x the size of a turn row and repeats
--                  the history on every call, so it is captured by POLICY
--                  (TELEMETRY_PAYLOADS: errors and fallbacks always, a
--                  deterministic sample of the rest) and EXPIRES (30 days by
--                  default, melchizedek_prune_telemetry() enforces it).
--
-- Join keys: adk_turns.trace_id = adk_telemetry.trace_id = adk_payloads.trace_id = adk_verdicts.ref = adk_labels.ref
--            adk_sessions.id     = app_name || ':' || user_id || ':' || adk_turns.session_id
--            adk_sessions.events[*].invocationId = adk_turns.invocation_id
--
-- Writes go through the service_role key. The anon/authenticated API paths
-- are closed by db/hardening.sql — re-run it after this file.

-- ── adk_telemetry: raw spans (v1 table, upgraded in place) ───────────────
CREATE TABLE IF NOT EXISTS adk_telemetry (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  span_name       TEXT NOT NULL,          -- 'llm.request' | 'Syndicate Execution: <name>'
  syndicate       TEXT,                   -- syndicate name, when known
  agent           TEXT,                   -- the agent that made the call / answered the turn
  provider        TEXT,                   -- 'gemini' | 'anthropic' | 'openai' | 'xai' | 'ollama'
  model           TEXT,                   -- model id as declared in YAML
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  thinking_tokens INTEGER,
  latency_ms      DOUBLE PRECISION,
  span            JSONB NOT NULL          -- full span (attributes, events, status)
);
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS session_id     TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS user_id        TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS task_id        TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS invocation_id  TEXT;
ALTER TABLE adk_telemetry ADD COLUMN IF NOT EXISTS schema_version SMALLINT NOT NULL DEFAULT 2;

CREATE INDEX IF NOT EXISTS idx_adk_telemetry_ts      ON adk_telemetry (ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_telemetry_trace   ON adk_telemetry (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_telemetry_session ON adk_telemetry (session_id);

-- ── adk_turns: one row per turn — the system of record ───────────────────
CREATE TABLE IF NOT EXISTS adk_turns (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts                 TIMESTAMPTZ NOT NULL,
  trace_id           TEXT NOT NULL,
  span_id            TEXT NOT NULL,
  -- identity
  session_id         TEXT,                -- the A2A contextId / CLI session id
  user_id            TEXT,                -- hashed caller silo (a2a-<keyhash>[/<siteUserId>])
  task_id            TEXT,                -- the A2A task
  invocation_id      TEXT,                -- ADK invocation: matches adk_sessions.events[*].invocationId
  -- what ran
  syndicate          TEXT NOT NULL,
  stage              TEXT NOT NULL DEFAULT 'delegate',  -- delegate | dispatch | classify | judge
  agent              TEXT,                -- the agent whose text became the answer
  route              TEXT,                -- plan-dispatch: the specialist chosen
  route_reason       TEXT,
  route_fell_back    BOOLEAN,
  route_via_override BOOLEAN,
  relay_fallback     BOOLEAN NOT NULL DEFAULT false,  -- DELEGATE: last tool result relayed verbatim
  -- the exchange
  input              TEXT,
  output             TEXT,
  error_code         TEXT,
  error_message      TEXT,
  -- cost and time
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  thinking_tokens    INTEGER,
  latency_ms         DOUBLE PRECISION,
  model_ms           DOUBLE PRECISION,    -- summed llm.request durations
  tool_ms            DOUBLE PRECISION,    -- summed ADK execute_tool durations
  llm_calls          INTEGER,
  tool_calls         INTEGER,
  models             TEXT[],
  -- evidence: [{name, tool, args, data}] — the full tool responses the answer was built from
  tool_events        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- provenance
  config_hash        TEXT,                -- lib/observability/lineage.ts configDigest()
  engine_version     TEXT,                -- "<package version>+<commit>"
  -- eval tagging (null on production traffic)
  eval_run           TEXT,
  eval_suite         TEXT,
  eval_case          TEXT,
  eval_variant       TEXT,
  eval_trial         INTEGER,
  -- everything else the span carried
  attributes         JSONB NOT NULL DEFAULT '{}'::jsonb,
  schema_version     SMALLINT NOT NULL DEFAULT 2,
  -- search
  search             TSVECTOR GENERATED ALWAYS AS
                       (to_tsvector('english', coalesce(input, '') || ' ' || coalesce(output, ''))) STORED,
  UNIQUE (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_adk_turns_ts        ON adk_turns (ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_trace     ON adk_turns (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_turns_session   ON adk_turns (session_id, ts);
CREATE INDEX IF NOT EXISTS idx_adk_turns_user      ON adk_turns (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_syndicate ON adk_turns (syndicate, ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_route     ON adk_turns (route);
CREATE INDEX IF NOT EXISTS idx_adk_turns_eval_run  ON adk_turns (eval_run);
CREATE INDEX IF NOT EXISTS idx_adk_turns_search    ON adk_turns USING gin (search);

-- ── Surface identity: WHERE the turn came from ───────────────────────────
-- The ledger's own identity columns describe the SERVER's view of a turn
-- (conversation, credential, task). They cannot say which Discord channel
-- asked, because the contextId is an opaque conversation key and user_id is
-- the caller's credential hash. A caller may name its own surface with the
-- optional X-Surface-* request headers; the server validates them, stamps
-- them on the root span, and they land here.
--
-- Deliberately additive and deliberately NOT tied to memory: the X-User-Id
-- header silos long-term memory, so using it to carry a Discord author id
-- would give every human their own memory silo and change what the desk
-- remembers. Observability must not change behavior, so this is a separate
-- channel that only ever reaches telemetry.
--
-- surface_user is a PSEUDONYM, not an account id: callers are expected to
-- send a salted hash (nihilistic-penguin sends one), so a channel's traffic
-- stays sliceable without the ledger holding a platform identity.
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface         TEXT;  -- 'discord' | 'cli' | 'web' | ...
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface_guild   TEXT;  -- Discord guild (server) id
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface_channel TEXT;  -- Discord channel id
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS surface_user    TEXT;  -- salted hash of the asker

CREATE INDEX IF NOT EXISTS idx_adk_turns_surface_channel
  ON adk_turns (surface, surface_channel, ts DESC);
CREATE INDEX IF NOT EXISTS idx_adk_turns_surface_user
  ON adk_turns (surface, surface_user, ts DESC);
-- Note for anyone applying these ALTERs by hand rather than re-running this
-- file: adk_turns_production below is `SELECT *`, and Postgres expands that
-- at CREATE time. It does not gain these columns until it is re-created, so
-- run the whole file, in order.

-- ── adk_payloads: full prompt/response per model call, by policy, expiring ─
CREATE TABLE IF NOT EXISTS adk_payloads (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL,
  trace_id        TEXT NOT NULL,
  span_id         TEXT NOT NULL,
  session_id      TEXT,
  invocation_id   TEXT,
  agent           TEXT,
  provider        TEXT,
  model           TEXT,
  reason          TEXT NOT NULL,          -- 'error' | 'fallback' | 'sample' | 'all'
  request         JSONB,                  -- the assembled model request (system instruction, history, tools)
  response        JSONB,                  -- the raw model response
  request_chars   INTEGER,
  response_chars  INTEGER,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days',
  schema_version  SMALLINT NOT NULL DEFAULT 2,
  UNIQUE (trace_id, span_id)
);

CREATE INDEX IF NOT EXISTS idx_adk_payloads_trace   ON adk_payloads (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_payloads_expires ON adk_payloads (expires_at);
CREATE INDEX IF NOT EXISTS idx_adk_payloads_session ON adk_payloads (session_id);

-- ── Retention ─────────────────────────────────────────────────────────────
-- Payloads expire by row; turns and raw spans are kept unless a turn_days
-- bound is passed. SECURITY DEFINER so a scheduled job can run it; revoked
-- from the API roles by db/hardening.sql.
CREATE OR REPLACE FUNCTION melchizedek_prune_telemetry(turn_days INTEGER DEFAULT NULL)
RETURNS TABLE(payloads_deleted BIGINT, turns_deleted BIGINT, spans_deleted BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p BIGINT := 0; t BIGINT := 0; s BIGINT := 0;
BEGIN
  DELETE FROM adk_payloads WHERE expires_at < now();
  GET DIAGNOSTICS p = ROW_COUNT;
  IF turn_days IS NOT NULL THEN
    DELETE FROM adk_turns WHERE ts < now() - make_interval(days => turn_days);
    GET DIAGNOSTICS t = ROW_COUNT;
    DELETE FROM adk_telemetry WHERE ts < now() - make_interval(days => turn_days);
    GET DIAGNOSTICS s = ROW_COUNT;
  END IF;
  RETURN QUERY SELECT p, t, s;
END;
$$;

-- Nightly prune when pg_cron is available (Supabase: Database → Extensions →
-- pg_cron). Without it, run `npm run telemetry:prune` on a schedule instead.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-telemetry', '17 3 * * *',
                          'SELECT melchizedek_prune_telemetry()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

-- ── A production-only view: the turns a user actually received ───────────
-- Excludes eval traffic, judge calls, and the plan-dispatch classifier's
-- own turn (stage 'classify' — joinable to its dispatch row by task_id).
CREATE OR REPLACE VIEW adk_turns_production AS
  SELECT * FROM adk_turns
  WHERE eval_run IS NULL AND stage IN ('delegate', 'dispatch');

-- ── adk_verdicts: the observatory's judgments, persisted (Phase 2) ────────
-- One row per (turn, judge, run). A re-judge with a new rubric is a new
-- run_id beside the old one, never an overwrite: judge_hash and
-- dataset_hash say exactly what graded what. `ref` is the turn's trace_id
-- when it has one, else a session key — so verdicts on session-sourced
-- exchanges persist too.
CREATE TABLE IF NOT EXISTS adk_verdicts (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  ref             TEXT NOT NULL,          -- trace_id, or 'session:<id>:<n>'
  trace_id        TEXT,
  run_id          TEXT NOT NULL,
  record_id       TEXT,
  suite           TEXT NOT NULL,
  case_id         TEXT,
  variant         TEXT,
  trial           INTEGER,
  judge           TEXT NOT NULL,          -- the judge label in the suite
  judge_kind      TEXT NOT NULL,          -- programmatic | llm | golden | pairwise
  judge_hash      TEXT,                   -- rubric + model + thresholds + script
  judge_model     TEXT,
  dataset_hash    TEXT,
  config_hash     TEXT,                   -- of the syndicate that produced the turn
  passed          BOOLEAN,
  score           DOUBLE PRECISION,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  rationale       TEXT,
  error           TEXT,
  judge_tokens    INTEGER,
  schema_version  SMALLINT NOT NULL DEFAULT 2,
  UNIQUE (ref, judge, run_id)
);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_ref   ON adk_verdicts (ref);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_trace ON adk_verdicts (trace_id);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_run   ON adk_verdicts (run_id);
CREATE INDEX IF NOT EXISTS idx_adk_verdicts_judge ON adk_verdicts (suite, judge, ts DESC);

-- ── adk_labels: human judgments, the calibration ground truth (Phase 2) ───
-- `observatory label` writes here. A label outlives every re-judge of the
-- same turn; judge-versus-human agreement (Cohen's kappa) is computed by
-- joining on ref.
CREATE TABLE IF NOT EXISTS adk_labels (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ts              TIMESTAMPTZ NOT NULL DEFAULT now(),
  ref             TEXT NOT NULL,
  trace_id        TEXT,
  labeler         TEXT NOT NULL,
  judge           TEXT,                   -- the judge this label calibrates; NULL = all
  suite           TEXT,
  run_id          TEXT,
  case_id         TEXT,
  variant         TEXT,
  passed          BOOLEAN,
  score           DOUBLE PRECISION,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  note            TEXT,
  schema_version  SMALLINT NOT NULL DEFAULT 2,
  UNIQUE (ref, labeler, judge)
);
CREATE INDEX IF NOT EXISTS idx_adk_labels_ref ON adk_labels (ref);

-- ── Semantic search over turns (Phase 3) ─────────────────────────────────
-- The same embedding model and dimensions as long-term memory
-- (lib/config.ts EMBEDDING_MODEL / EMBEDDING_DIMENSIONS). Rows are embedded
-- by `npm run telemetry:embed` (a job, not the exporter — inference stays
-- off the export path); `observatory search --semantic` queries them.
ALTER TABLE adk_turns ADD COLUMN IF NOT EXISTS embedding vector(768);
DO $idx$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'idx_adk_turns_embedding') THEN
    BEGIN
      EXECUTE 'CREATE INDEX idx_adk_turns_embedding ON adk_turns USING hnsw (embedding vector_cosine_ops)';
    EXCEPTION WHEN OTHERS THEN
      EXECUTE 'CREATE INDEX idx_adk_turns_embedding ON adk_turns USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)';
    END;
  END IF;
END
$idx$;

CREATE OR REPLACE FUNCTION match_turns(
  query_embedding vector(768),
  match_count INTEGER DEFAULT 20,
  since TIMESTAMPTZ DEFAULT NULL,
  filter_syndicate TEXT DEFAULT NULL,
  filter_route TEXT DEFAULT NULL,
  include_evals BOOLEAN DEFAULT false
)
RETURNS TABLE(
  id BIGINT, ts TIMESTAMPTZ, trace_id TEXT, session_id TEXT, syndicate TEXT, stage TEXT, route TEXT, agent TEXT,
  input TEXT, output TEXT, latency_ms DOUBLE PRECISION, similarity DOUBLE PRECISION
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id, t.ts, t.trace_id, t.session_id, t.syndicate, t.stage, t.route, t.agent, t.input, t.output, t.latency_ms,
         1 - (t.embedding <=> query_embedding) AS similarity
  FROM adk_turns t
  WHERE t.embedding IS NOT NULL
    AND t.stage IN ('delegate', 'dispatch')
    AND (include_evals OR t.eval_run IS NULL)
    AND (since IS NULL OR t.ts >= since)
    AND (filter_syndicate IS NULL OR t.syndicate = filter_syndicate)
    AND (filter_route IS NULL OR t.route = filter_route)
  ORDER BY t.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- ── KPI views (Phase 5) ───────────────────────────────────────────────────
-- Standing daily aggregates over production turns and persisted verdicts,
-- for dashboards (Supabase charts, Metabase, Grafana) and the alert job.
CREATE OR REPLACE VIEW adk_kpi_daily AS
  SELECT date_trunc('day', ts) AS day,
         syndicate,
         count(*)                                           AS turns,
         count(DISTINCT session_id)                         AS sessions,
         count(DISTINCT user_id)                            AS users,
         avg((error_code IS NOT NULL)::int)                 AS error_rate,
         avg(coalesce(route_fell_back, false)::int)         AS route_fallback_rate,
         avg(relay_fallback::int)                           AS relay_fallback_rate,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)  AS p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
         sum(input_tokens)                                  AS input_tokens,
         sum(output_tokens)                                 AS output_tokens,
         sum(thinking_tokens)                               AS thinking_tokens,
         avg(llm_calls)                                     AS avg_llm_calls,
         avg(tool_calls)                                    AS avg_tool_calls
  FROM adk_turns_production
  GROUP BY 1, 2;

CREATE OR REPLACE VIEW adk_kpi_routes_daily AS
  SELECT date_trunc('day', ts) AS day,
         syndicate,
         coalesce(route, agent) AS route,
         count(*)                                           AS turns,
         avg((error_code IS NOT NULL)::int)                 AS error_rate,
         avg(coalesce(route_fell_back, false)::int)         AS route_fallback_rate,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
         avg(latency_ms)                                    AS mean_ms,
         sum(input_tokens + output_tokens)                  AS tokens
  FROM adk_turns_production
  GROUP BY 1, 2, 3;

CREATE OR REPLACE VIEW adk_kpi_judges_daily AS
  SELECT date_trunc('day', v.ts) AS day,
         v.suite, v.judge, v.judge_kind, v.variant,
         count(*)                                  AS verdicts,
         avg(v.passed::int)                        AS pass_rate,
         avg(v.score)                              AS mean_score,
         count(*) FILTER (WHERE v.error IS NOT NULL) AS judge_errors
  FROM adk_verdicts v
  GROUP BY 1, 2, 3, 4, 5;

-- Hourly variant for alerts: the last N hours at a glance.
CREATE OR REPLACE VIEW adk_kpi_hourly AS
  SELECT date_trunc('hour', ts) AS hour,
         syndicate,
         count(*)                                           AS turns,
         avg((error_code IS NOT NULL)::int)                 AS error_rate,
         avg(coalesce(route_fell_back, false)::int)         AS route_fallback_rate,
         avg(relay_fallback::int)                           AS relay_fallback_rate,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms,
         sum(input_tokens + output_tokens)                  AS tokens
  FROM adk_turns_production
  GROUP BY 1, 2;
