-- ============================================================================
-- 0003_postgres_storage — tables the direct-Postgres adapter writes (ADR 0021)
-- ============================================================================
-- lib/storage/postgres/ uses these instead of the whole-row JSONB rewrite the
-- Supabase session service does. Both adapters share adk_sessions (one row per
-- conversation: state, timestamps, expiry); the Postgres adapter keeps the
-- events here, one row per event, so two turns appending to one conversation
-- both land instead of the later write erasing the earlier one.
-- ============================================================================

-- ── 1. Session events: append-only, one row per event ──────────────────────
CREATE TABLE IF NOT EXISTS adk_session_events (
  session_id TEXT    NOT NULL REFERENCES adk_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  ts         DOUBLE PRECISION,           -- the event's own timestamp (seconds)
  event      JSONB   NOT NULL,
  PRIMARY KEY (session_id, seq)
);

-- ── 2. A2A tasks: durable, shared across instances, scoped to their owner ──
-- One row per task. tenant/owner come from the A2A ServerCallContext
-- (the SDK's own scoping rule), so one caller cannot read another's task by
-- id, and a task survives a restart or a poll that lands on another process.
CREATE TABLE IF NOT EXISTS adk_a2a_tasks (
  tenant     TEXT        NOT NULL DEFAULT '',
  owner      TEXT        NOT NULL,
  agent_id   TEXT        NOT NULL,
  id         TEXT        NOT NULL,
  context_id TEXT,
  state      INTEGER,                    -- TaskState enum value
  status_ts  TEXT,                       -- task.status.timestamp (ISO), the list order
  task       JSONB       NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expire_at  TIMESTAMPTZ,
  PRIMARY KEY (tenant, owner, agent_id, id)
);
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_list_idx
  ON adk_a2a_tasks (tenant, owner, agent_id, status_ts DESC, id DESC);
CREATE INDEX IF NOT EXISTS adk_a2a_tasks_expire_idx ON adk_a2a_tasks (expire_at);

-- ── 3. Lock both down like every other table ───────────────────────────────
-- (db/hardening.sql repeats this; it must also hold for a database that is
-- never hardened, such as a private Postgres with no REST layer.)
ALTER TABLE adk_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE adk_a2a_tasks ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON adk_session_events, adk_a2a_tasks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON adk_session_events, adk_a2a_tasks FROM authenticated;
  END IF;
END $$;

INSERT INTO melchizedek_schema_version (version, name)
VALUES (3, '0003_postgres_storage')
ON CONFLICT (version) DO NOTHING;
