-- ============================================================
-- Melchizedek — Database Hardening (run AFTER the numbered migrations in
-- db/migrations/ and, if upgrading, after db/memory_v2.sql — order with
-- memory_v2 does not matter; the function revoke below handles either
-- signature). `npm run db -- apply` runs it last; it is idempotent.
-- ============================================================
--
-- WHY THIS EXISTS
-- In a default Supabase project, tables created in the `public` schema are
-- exposed through the auto-generated REST API (PostgREST) and are readable/
-- writable with the widely-distributed `anon` key whenever Row-Level
-- Security is disabled. Melchizedek's `adk_sessions` (conversation
-- transcripts), `adk_memory_facts` (distilled user facts) and
-- `adk_agent_registry` (the agent definitions the A2A server boots from)
-- must never be reachable that way. The registry is the sharpest of the
-- three: anon write access there means replacing an agent's instruction and
-- tool list, i.e. taking over every server that boots `registry:<id>`.
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

-- Optional observability ledger (db/telemetry.sql). Guarded: the tables only
-- exist when the operator opted into TELEMETRY_SUPABASE. adk_turns holds
-- user input and output, adk_payloads full prompts — same lockdown as the
-- transcript tables, for the same reason.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['adk_telemetry', 'adk_turns', 'adk_payloads', 'adk_verdicts', 'adk_labels',
                            'adk_session_events', 'adk_a2a_tasks', 'melchizedek_usage'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
  -- The production view and the retention function read/delete those
  -- tables on behalf of the caller; neither belongs on the public API.
  FOREACH t IN ARRAY ARRAY['adk_turns_production', 'adk_kpi_daily', 'adk_kpi_routes_daily', 'adk_kpi_judges_daily', 'adk_kpi_hourly'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END IF;
  END LOOP;
  -- Function privileges for these are handled in the FUNCTIONS block below.
END $$;

-- Schema bookkeeping (db/migrations). Nothing secret, but nothing the public
-- API needs either.
DO $$
BEGIN
  IF to_regclass('public.melchizedek_schema_version') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE melchizedek_schema_version ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON melchizedek_schema_version FROM anon, authenticated';
  END IF;
END $$;

-- Agent registry (adk_agent_registry). Guarded the same way: the table
-- only exists in deployments that boot syndicates with `registry:<id>`.
-- Read exposure leaks every system prompt; write exposure is agent takeover.
DO $$
BEGIN
  IF to_regclass('public.adk_agent_registry') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE adk_agent_registry ENABLE ROW LEVEL SECURITY';
    EXECUTE 'REVOKE ALL ON adk_agent_registry FROM anon, authenticated';
  END IF;
END $$;

-- ── FUNCTIONS: no API role may execute them ──────────────────────────────
-- Postgres grants EXECUTE on every new function to PUBLIC, and anon and
-- authenticated inherit PUBLIC — so revoking from those two roles BY NAME
-- alone would leave the PUBLIC grant in force. Two
-- of these are SECURITY DEFINER (they bypass RLS): through the anon key,
-- match_turns would read stored conversations and the prune functions would
-- delete the ledger and sessions. Revoke from PUBLIC as well, then grant
-- back to service_role only (the server's role; it is not a superuser and
-- would otherwise lose access too).
--
-- Every overload of every melchizedek function is covered by name, so this
-- works on any schema version.
DO $$
DECLARE
  fn regprocedure;
  has_service_role boolean := EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role');
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('match_memory_facts', 'match_turns', 'melchizedek_prune_telemetry',
                        'melchizedek_prune_sessions', 'melchizedek_rls_status',
                        'melchizedek_erase_scope', 'melchizedek_usage_add', 'melchizedek_prune_usage')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    IF has_service_role THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END IF;
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
    AND c.relname IN ('adk_memory_facts', 'adk_sessions', 'adk_telemetry',
                      'adk_turns', 'adk_payloads', 'adk_verdicts', 'adk_labels',
                      'adk_agent_registry', 'adk_session_events', 'adk_a2a_tasks',
                      'melchizedek_usage');
$$;

REVOKE ALL ON FUNCTION melchizedek_rls_status() FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION melchizedek_rls_status() TO service_role;
  END IF;
END $$;

-- Verify (each must return false):
--   SELECT has_function_privilege('anon', 'match_turns(vector,integer,timestamptz,text,text,boolean)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'melchizedek_prune_telemetry(integer)', 'EXECUTE');
--   SELECT has_function_privilege('anon', 'melchizedek_prune_sessions()', 'EXECUTE');

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
