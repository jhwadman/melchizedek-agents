---
type: schema
title: Memory & telemetry schema
description: "The canonical Supabase DDL: memory facts table with pgvector search, telemetry sink, and row-level-security hardening."
tags:
  - schema
  - supabase
  - memory
generated:
  by: process:wiki-build
  at: 2026-07-26
sources:
  - resource: db/memory_v2.sql
  - resource: db/telemetry.sql
  - resource: db/hardening.sql
---

# Memory & telemetry schema

The generated sections below are the db/*.sql files verbatim — the canonical form. The same DDL is mirrored prose-side in README.md and DOCUMENTATION.md (private and overlay); per CLAUDE.md those four mirrors must stay identical, and this document derives from the db/ copy so it cannot drift from it.

<!-- wiki:generated section="memory-ddl" source="db/memory_v2.sql" -->
## Memory facts (v2 upgrade path)

```sql
-- ============================================================================
-- memory_v2.sql — structured memory records for adk_memory_facts
--
-- Run in the Supabase SQL Editor AFTER the base schema (README §Supabase
-- setup). Idempotent; safe to re-run. Existing rows survive: old facts get
-- status 'active', empty keys, and NULL tag/date/source — they keep working
-- as plain semantic memories.
--
-- What this adds:
--   * structured columns: tag, fact_date, source, status, keys, superseded_by
--   * indexes for the two non-semantic recall channels (keys, dates)
--   * match_memory_facts v2 — same call signature, now returns the
--     structured columns so the service can re-rank and relabel.
-- ============================================================================

-- 1. Structured record columns
ALTER TABLE adk_memory_facts
  ADD COLUMN IF NOT EXISTS tag TEXT,
  ADD COLUMN IF NOT EXISTS fact_date DATE,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS keys TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- 2. Recall-channel indexes: entity keys (GIN) and dates (btree, per user)
CREATE INDEX IF NOT EXISTS adk_memory_facts_keys_idx
  ON adk_memory_facts USING gin (keys);
CREATE INDEX IF NOT EXISTS adk_memory_facts_date_idx
  ON adk_memory_facts (user_key, fact_date);

-- 3. match_memory_facts v2 — drop every prior signature first (Postgres
--    overloads functions by argument list; leaving an old one creates an
--    ambiguous call).
DROP FUNCTION IF EXISTS match_memory_facts(vector, int, text);
DROP FUNCTION IF EXISTS match_memory_facts(vector, text, int);

CREATE OR REPLACE FUNCTION match_memory_facts (
  query_embedding vector(768),
  filter_user_key text,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id UUID,
  user_key TEXT,
  fact TEXT,
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT,
  keys TEXT[],
  created_at TIMESTAMPTZ,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF filter_user_key IS NULL THEN
    RAISE EXCEPTION 'filter_user_key is required';
  END IF;
  RETURN QUERY
  SELECT
    adk_memory_facts.id,
    adk_memory_facts.user_key,
    adk_memory_facts.fact,
    adk_memory_facts.tag,
    adk_memory_facts.fact_date,
    adk_memory_facts.source,
    adk_memory_facts.status,
    adk_memory_facts.keys,
    adk_memory_facts.created_at,
    1 - (adk_memory_facts.embedding <=> query_embedding) AS similarity
  FROM adk_memory_facts
  WHERE adk_memory_facts.user_key = filter_user_key
  ORDER BY adk_memory_facts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```
<!-- /wiki:generated -->

<!-- wiki:generated section="telemetry-ddl" source="db/telemetry.sql" -->
## Telemetry sink

```sql
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
```
<!-- /wiki:generated -->

<!-- wiki:generated section="hardening-ddl" source="db/hardening.sql" -->
## Hardening (RLS)

```sql
-- ============================================================
-- Melchizedek — Database Hardening (run AFTER the schema SQL in README.md
-- and, if upgrading, after db/memory_v2.sql — order with memory_v2 does
-- not matter; the function revoke below handles either signature).
-- Paste into the Supabase SQL Editor and run once per project.
-- ============================================================
--
-- WHY THIS EXISTS
-- In a default Supabase project, tables created in the `public` schema are
-- exposed through the auto-generated REST API (PostgREST) and are readable/
-- writable with the widely-distributed `anon` key whenever Row-Level
-- Security is disabled. Melchizedek's `adk_sessions` (conversation
-- transcripts) and `adk_memory_facts` (distilled user facts) must never be
-- reachable that way.
--
-- WHAT EACH TIER BUYS — BE HONEST WITH YOURSELF ABOUT THIS:
--   Tier 1 (this file): closes the anon/authenticated API paths entirely.
--     The Melchizedek server itself connects with the service_role key,
--     which BYPASSES RLS by design — so tier 1 does not constrain the
--     server; it constrains everyone else.
--   Tier 2 (documented at the bottom, not enabled by default): a dedicated
--     runtime role bound by RLS policies scoped to one user_key per
--     request. This constrains the server too — a bug in application code
--     cannot read across silos. It requires connecting via a direct
--     Postgres role instead of the service_role REST client.
--
-- The A2A server checks at boot whether this file has been applied and
-- prints a prominent warning if not (see lib/persistence/supabaseProvider.ts).

-- ── Tier 1: lock the public API paths ────────────────────────────────────

-- Enable RLS. With RLS on and NO policies defined, anon/authenticated get
-- deny-by-default. service_role is unaffected (it bypasses RLS).
ALTER TABLE adk_memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_sessions     ENABLE ROW LEVEL SECURITY;

-- Belt and suspenders: also revoke the default table privileges from the
-- API roles, so even a future accidentally-created permissive policy
-- cannot re-expose the tables.
REVOKE ALL ON adk_memory_facts FROM anon, authenticated;
REVOKE ALL ON adk_sessions     FROM anon, authenticated;

-- Optional telemetry sink (db/telemetry.sql). Guarded: the table only
-- exists when the operator opted into TELEMETRY_SUPABASE. Token counts and
-- span payloads are operational data — same lockdown as the other tables.
DO $$
BEGIN
  IF to_regclass('public.adk_telemetry') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_telemetry ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON adk_telemetry FROM anon, authenticated';
  END IF;
END $$;

-- The vector-search RPC must not be callable from the public API either
-- (it reads adk_memory_facts on behalf of whoever calls it). The revoke
-- resolves every existing overload by name, so it works on any schema
-- version (the v1 signature, memory_v2's, or both side by side).
DO $$
DECLARE fn regprocedure;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'match_memory_facts'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', fn);
  END LOOP;
END $$;

-- ── Boot-time verification hook ──────────────────────────────────────────
-- The server calls this to confirm hardening is applied. SECURITY DEFINER
-- so it can read pg_class regardless of caller privileges; it exposes
-- nothing but two booleans.
CREATE OR REPLACE FUNCTION melchizedek_rls_status()
RETURNS TABLE(table_name text, rls_enabled boolean)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.relname::text, c.relrowsecurity
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('adk_memory_facts', 'adk_sessions', 'adk_telemetry');
$$;

REVOKE ALL ON FUNCTION melchizedek_rls_status() FROM anon, authenticated;

-- ── Tier 2 (optional, for sensitive deployments): constrain the server ───
-- Left commented out because it requires an application change: the server
-- must connect as this role (direct Postgres connection string, not the
-- service_role REST client) and set `app.user_key` per transaction:
--
--   SET LOCAL app.user_key = 'melchizedek-a2a/a2a-<keyhash>/<userId>';
--
-- With that in place, even buggy application code cannot read or delete
-- another silo's rows — the database refuses.
--
-- CREATE ROLE melchizedek_app LOGIN PASSWORD '<strong-password>';
-- GRANT USAGE ON SCHEMA public TO melchizedek_app;
-- GRANT SELECT, INSERT, DELETE ON adk_memory_facts TO melchizedek_app;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON adk_sessions TO melchizedek_app;
--
-- CREATE POLICY memory_silo ON adk_memory_facts
--   FOR ALL TO melchizedek_app
--   USING (user_key = current_setting('app.user_key', true))
--   WITH CHECK (user_key = current_setting('app.user_key', true));
--
-- CREATE POLICY session_silo ON adk_sessions
--   FOR ALL TO melchizedek_app
--   USING (user_id = split_part(current_setting('app.user_key', true), '/', 2))
--   WITH CHECK (user_id = split_part(current_setting('app.user_key', true), '/', 2));
```
<!-- /wiki:generated -->

How the pipeline uses these tables: [memory architecture](/memory/architecture.md).
