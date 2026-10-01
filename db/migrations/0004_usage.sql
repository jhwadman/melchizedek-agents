-- ============================================================================
-- 0004_usage — per-day usage counters for budgets (ADR 0026)
-- ============================================================================
-- One row per (UTC day, subject). A subject is 'caller:<name>' or
-- 'scope:<SHA-256 prefix of the scope key>': no user identifier is stored.
-- The server adds each finished task's spend with melchizedek_usage_add, one
-- atomic upsert, so several instances share the same counts. Rows hold
-- numbers only: no user text, no credentials.
-- ============================================================================

CREATE TABLE IF NOT EXISTS melchizedek_usage (
  day             DATE        NOT NULL,
  subject         TEXT        NOT NULL,
  tasks           BIGINT      NOT NULL DEFAULT 0,
  llm_calls       BIGINT      NOT NULL DEFAULT 0,
  input_tokens    BIGINT      NOT NULL DEFAULT 0,
  output_tokens   BIGINT      NOT NULL DEFAULT 0,
  thinking_tokens BIGINT      NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (day, subject)
);

-- Adds to a subject's counters for one day and returns the new totals.
CREATE OR REPLACE FUNCTION melchizedek_usage_add(
  p_day      date,
  p_subject  text,
  p_tasks    bigint,
  p_calls    bigint,
  p_input    bigint,
  p_output   bigint,
  p_thinking bigint
) RETURNS TABLE(tasks bigint, llm_calls bigint, input_tokens bigint, output_tokens bigint, thinking_tokens bigint)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  INSERT INTO melchizedek_usage AS u (day, subject, tasks, llm_calls, input_tokens, output_tokens, thinking_tokens)
  VALUES (p_day, p_subject, p_tasks, p_calls, p_input, p_output, p_thinking)
  ON CONFLICT (day, subject) DO UPDATE SET
    tasks           = u.tasks + EXCLUDED.tasks,
    llm_calls       = u.llm_calls + EXCLUDED.llm_calls,
    input_tokens    = u.input_tokens + EXCLUDED.input_tokens,
    output_tokens   = u.output_tokens + EXCLUDED.output_tokens,
    thinking_tokens = u.thinking_tokens + EXCLUDED.thinking_tokens,
    updated_at      = NOW()
  RETURNING u.tasks, u.llm_calls, u.input_tokens, u.output_tokens, u.thinking_tokens;
$$;

-- Old days are history, not budget: keep 90 days.
CREATE OR REPLACE FUNCTION melchizedek_prune_usage()
RETURNS BIGINT
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  WITH gone AS (DELETE FROM melchizedek_usage WHERE day < CURRENT_DATE - 90 RETURNING 1)
  SELECT count(*) FROM gone;
$$;

ALTER TABLE melchizedek_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION melchizedek_prune_usage() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON melchizedek_usage FROM anon;
    REVOKE ALL ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) FROM anon;
    REVOKE ALL ON FUNCTION melchizedek_prune_usage() FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON melchizedek_usage FROM authenticated;
    REVOKE ALL ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) FROM authenticated;
    REVOKE ALL ON FUNCTION melchizedek_prune_usage() FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION melchizedek_usage_add(date, text, bigint, bigint, bigint, bigint, bigint) TO service_role;
    GRANT EXECUTE ON FUNCTION melchizedek_prune_usage() TO service_role;
  END IF;
END $$;

-- Nightly with the session prune, when pg_cron is available.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('melchizedek-prune-usage', '29 3 * * *', 'SELECT melchizedek_prune_usage()');
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (4, '0004_usage')
ON CONFLICT (version) DO NOTHING;
