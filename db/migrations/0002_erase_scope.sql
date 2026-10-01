-- ============================================================================
-- 0002_erase_scope — one erase operation across every store (ADR 0020 item 7)
-- ============================================================================
-- melchizedek_erase_scope(scope_key, namespace, include_nested) deletes
-- everything that holds a scope's words, in one transaction, and returns a
-- row count per store:
--
--   memory_facts   adk_memory_facts   user_key = '<namespace>/<scope_key>'
--   sessions       adk_sessions       the scope's conversations, INCLUDING the
--                                     per-subagent rows ADK writes beside them
--                                     ('<SubAgent>:<scope>:<context>')
--   turns          adk_turns          ledger rows for those conversations
--   spans          adk_telemetry      spans of those turns' traces
--   payloads       adk_payloads       captured prompts of those traces
--   verdicts       adk_verdicts       judgments of those traces
--   labels         adk_labels         human labels of those traces
--   tasks          adk_a2a_tasks      A2A tasks the scope owns in those conversations
--                                     (0003; the Postgres adapter's task store)
--
-- namespace NULL erases the scope in every namespace. include_nested also
-- erases scopes nested beneath this one ('<scope_key>/...'), which is how a
-- key-level silo is erased together with its end users under keyMode byok.
-- Ledger tables are optional (db/telemetry.sql); absent ones report 0.
--
-- Conversations are identified by context id. When the same scope reused one
-- context id with two namespaces, a namespace-scoped erase removes both
-- conversations: erasure errs toward deleting, never toward keeping.
--
-- SECURITY INVOKER: it can delete only what the calling role can. It is
-- revoked from PUBLIC here and again by db/hardening.sql, and granted to
-- service_role where that role exists (Supabase).
-- ============================================================================

CREATE OR REPLACE FUNCTION melchizedek_erase_scope(
  p_scope_key      text,
  p_namespace      text    DEFAULT NULL,
  p_include_nested boolean DEFAULT false
) RETURNS TABLE(store text, deleted bigint)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  -- LIKE pattern for scopes nested beneath this one, with the scope's own
  -- wildcard characters escaped.
  nested_like text := replace(replace(replace(p_scope_key, '\', '\\'), '%', '\%'), '_', '\_') || '/%';
  contexts    text[];
  traces      text[];
  n           bigint;
BEGIN
  IF p_scope_key IS NULL OR btrim(p_scope_key) = '' THEN
    RAISE EXCEPTION 'melchizedek_erase_scope: scope_key is required';
  END IF;

  -- The conversations (context ids) being erased. With a namespace, they are
  -- the namespace's own session rows; without one, every row of the scope.
  -- adk_sessions.id is '<app_name>:<user_id>:<context id>'.
  SELECT coalesce(array_agg(DISTINCT substr(s.id, length(s.app_name) + length(s.user_id) + 3)), '{}')
    INTO contexts
  FROM adk_sessions s
  WHERE (s.user_id = p_scope_key OR (p_include_nested AND s.user_id LIKE nested_like))
    AND (p_namespace IS NULL OR s.app_name = p_namespace);

  -- Ledger traces of those conversations, collected before anything is deleted.
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(array_agg(DISTINCT trace_id), '{}') FROM adk_turns
      WHERE (user_id = $1 OR ($2 AND user_id LIKE $3))
        AND ($4 IS NULL OR session_id = ANY($5))
    $q$ INTO traces USING p_scope_key, p_include_nested, nested_like, p_namespace, contexts;
  ELSE
    traces := '{}';
  END IF;

  -- Memory facts. user_key is '<namespace>/<scope>' and a namespace never
  -- contains '/', so the scope is exactly what follows the first slash.
  DELETE FROM adk_memory_facts f
  WHERE (p_namespace IS NULL OR split_part(f.user_key, '/', 1) = p_namespace)
    AND (substr(f.user_key, strpos(f.user_key, '/') + 1) = p_scope_key
         OR (p_include_nested AND substr(f.user_key, strpos(f.user_key, '/') + 1) LIKE nested_like));
  GET DIAGNOSTICS n = ROW_COUNT;
  store := 'memory_facts'; deleted := n; RETURN NEXT;

  -- Sessions: every row of the scope in those conversations, whatever app
  -- name ADK gave it (subagents run under their own agent name).
  DELETE FROM adk_sessions s
  WHERE (s.user_id = p_scope_key OR (p_include_nested AND s.user_id LIKE nested_like))
    AND substr(s.id, length(s.app_name) + length(s.user_id) + 3) = ANY(contexts);
  GET DIAGNOSTICS n = ROW_COUNT;
  store := 'sessions'; deleted := n; RETURN NEXT;

  -- The ledger, when installed.
  IF to_regclass('public.adk_turns') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM adk_turns
      WHERE (user_id = $1 OR ($2 AND user_id LIKE $3))
        AND ($4 IS NULL OR session_id = ANY($5))
    $q$ USING p_scope_key, p_include_nested, nested_like, p_namespace, contexts;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'turns'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_telemetry') IS NOT NULL THEN
    EXECUTE 'DELETE FROM adk_telemetry WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'spans'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_payloads') IS NOT NULL THEN
    EXECUTE 'DELETE FROM adk_payloads WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'payloads'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_verdicts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM adk_verdicts WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'verdicts'; deleted := n; RETURN NEXT;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'adk_labels' AND column_name = 'trace_id'
  ) THEN
    EXECUTE 'DELETE FROM adk_labels WHERE trace_id = ANY($1)' USING traces;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'labels'; deleted := n; RETURN NEXT;

  IF to_regclass('public.adk_a2a_tasks') IS NOT NULL THEN
    EXECUTE $q$
      DELETE FROM adk_a2a_tasks
      WHERE (owner = $1 OR ($2 AND owner LIKE $3))
        AND ($4 IS NULL OR context_id = ANY($5))
    $q$ USING p_scope_key, p_include_nested, nested_like, p_namespace, contexts;
    GET DIAGNOSTICS n = ROW_COUNT;
  ELSE
    n := 0;
  END IF;
  store := 'tasks'; deleted := n; RETURN NEXT;
END;
$$;

-- No API role may execute it (db/hardening.sql repeats this for every
-- melchizedek function); the server's role gets it back.
DO $$
BEGIN
  REVOKE ALL ON FUNCTION melchizedek_erase_scope(text, text, boolean) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION melchizedek_erase_scope(text, text, boolean) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON FUNCTION melchizedek_erase_scope(text, text, boolean) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION melchizedek_erase_scope(text, text, boolean) TO service_role;
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (2, '0002_erase_scope')
ON CONFLICT (version) DO NOTHING;
