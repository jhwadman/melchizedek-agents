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
