-- ============================================================================
-- 0001_base.sql — the base schema: sessions and long-term memory.
--
-- Migrations in db/migrations/ run in filename order, then db/hardening.sql
-- (required before serving real users), then optionally db/telemetry.sql
-- (and hardening.sql again). `npx melchizedek-db apply` does exactly that;
-- `print` emits the same SQL to paste into the Supabase SQL Editor.
--
-- Every statement is idempotent: re-running a migration changes nothing
-- already in place, so this file is also the upgrade path from any earlier
-- layout (it subsumes db/memory_v2.sql). Each migration records its own
-- number in melchizedek_schema_version as its last statement.
--
-- The vector width (768) must equal EMBEDDING_DIMENSIONS in lib/config.ts.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ── 1. Sessions ──────────────────────────────────────────────────────────────
-- One row per conversation. `id` is the composite `{appName}:{userId}:{sessionId}`
-- (TEXT, not UUID), which isolates parallel subagents sharing one session id.
CREATE TABLE IF NOT EXISTS adk_sessions (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state JSONB DEFAULT '{}'::jsonb,
  events JSONB DEFAULT '[]'::jsonb,
  last_update_time BIGINT,
  expire_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Retention: every write pushes expire_at seven days out, so a conversation
-- idle for seven days expires. The prune below deletes expired rows.
CREATE INDEX IF NOT EXISTS adk_sessions_expire_idx ON adk_sessions (expire_at);
CREATE INDEX IF NOT EXISTS adk_sessions_user_idx ON adk_sessions (app_name, user_id);

-- ── 2. Long-term memory ──────────────────────────────────────────────────────
-- Structured records: every fact carries its date, source, active/superseded
-- status and entity keys alongside the embedding (lib/memory/README.md).
CREATE TABLE IF NOT EXISTS adk_memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding vector(768),
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  keys TEXT[] NOT NULL DEFAULT '{}',
  superseded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Older layouts: add the structured columns where they are missing.
ALTER TABLE adk_memory_facts
  ADD COLUMN IF NOT EXISTS tag TEXT,
  ADD COLUMN IF NOT EXISTS fact_date DATE,
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS keys TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS superseded_by UUID;

-- Every query filters on user_key first; per-user sets are small, so an
-- exact scan within the silo is the dependable plan. The HNSW index serves
-- the large-silo case and, unlike an IVFFlat index built on an empty
-- table, needs no training data. (An existing IVFFlat index from an older
-- layout keeps working; drop it once this one exists if you like.)
CREATE INDEX IF NOT EXISTS adk_memory_facts_user_idx ON adk_memory_facts (user_key);
CREATE INDEX IF NOT EXISTS adk_memory_facts_embedding_hnsw_idx
  ON adk_memory_facts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS adk_memory_facts_keys_idx ON adk_memory_facts USING gin (keys);
CREATE INDEX IF NOT EXISTS adk_memory_facts_date_idx ON adk_memory_facts (user_key, fact_date);

-- ── 3. Recall RPC ────────────────────────────────────────────────────────────
-- filter_user_key is REQUIRED: a NULL key would return every user's facts.
-- Every earlier signature is dropped first (Postgres overloads by argument
-- list; a leftover overload makes the call ambiguous).
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

-- ── 4. Session retention ─────────────────────────────────────────────────────
-- Deletes conversations whose expire_at has passed, including the per-
-- subagent rows ADK writes beside them. SECURITY DEFINER so a scheduled job
-- can run it; db/hardening.sql revokes it from every API role.
CREATE OR REPLACE FUNCTION melchizedek_prune_sessions()
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n BIGINT := 0;
BEGIN
  DELETE FROM adk_sessions WHERE expire_at IS NOT NULL AND expire_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Nightly when pg_cron is available (Supabase: Database → Extensions →
-- pg_cron). Without it, run `npm run sessions:prune` on a schedule.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-sessions', '23 3 * * *',
                          'SELECT melchizedek_prune_sessions()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

-- ── 5. Schema version ────────────────────────────────────────────────────────
-- One row per applied migration, so tooling (and the server) can tell a
-- current database from a stale one. Every migration ends by inserting its
-- own number.
CREATE TABLE IF NOT EXISTS melchizedek_schema_version (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO melchizedek_schema_version (version, name)
VALUES (1, '0001_base')
ON CONFLICT (version) DO NOTHING;
