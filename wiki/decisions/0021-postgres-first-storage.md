---
type: decision
title: 'ADR 0021: One Postgres connection holds every durable store; in-memory is the single-instance default; Redis is optional'
description: Durable state — sessions, memory, A2A tasks, the job queue, per-conversation locks, limit counters and the agent registry — goes through one storage adapter on the pg driver, with versioned migrations and a private schema; multi-instance deployment is supported exactly when that adapter is plugged in; supabase-js is deprecated; Redis is an optional limiter adapter, and an API gateway may own limits instead.
tags:
  - decision
  - memory
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/persistence/supabaseProvider.ts
  - resource: lib/session/supabaseSessionService.ts
  - resource: db/hardening.sql
  - resource: lib/a2a/app.ts
---

# ADR 0021: One Postgres connection holds every durable store; in-memory is the single-instance default; Redis is optional

## Context

**Topology.** Four pieces of state lived only in process memory:

- the A2A task list;
- the loaded agent configs;
- the rate-limit counters;
- the memory "processed" marker.

With two instances behind a load balancer, a client polling for its task could reach the instance that never saw it. A restart lost every in-flight task. The documentation called the server stateless.

**Storage.** The SQL was plain Postgres with pgvector, but every access went through `supabase-js`, which talks HTTP to Supabase's REST layer. That forced the tables into the API-exposed `public` schema, and their exposure to the anon key then had to be patched by `db/hardening.sql`: the boot check, the revoke lists, and an unrevoked `PUBLIC` grant on two functions.

There was no plain-Postgres path and no migrations; the base schema existed only as SQL inside Markdown. Sessions were rewritten whole on every event, so two concurrent turns overwrote each other.

## Decision

1. **One storage adapter on the `pg` driver,** `postgresStorage(DATABASE_URL)`. It holds every durable store:

| Store | Mechanism |
|---|---|
| Sessions | Append-only events table, one row per event; session row keeps state and a version |
| Memory | `adk_memory_facts` and the durable processed marker ([ADR 0020](/decisions/0020-memory-contract.md)) |
| A2A tasks | Task table, owner-scoped, with a lease so a restarted instance marks orphaned tasks failed |
| Job queue | `FOR UPDATE SKIP LOCKED` |
| One turn at a time per conversation | Advisory lock on the context id |
| Limits and budgets | Counters table |
| Agent registry | Versioned rows ([ADR 0018](/decisions/0018-files-are-the-source-of-truth.md)) |

> **Note (2026-10-01):** `postgresStorage({ connectionString })` holds sessions (an append-only events table, appended under a row lock), memory, owner-scoped A2A tasks and erasure, and budget counters live in `melchizedek_usage`. Not yet on it: the job queue (the task tools keep a local JSON store), task leases, a per-conversation turn lock, and the agent registry, see [ADR 0018](/decisions/0018-files-are-the-source-of-truth.md).

2. **It works on any Postgres:** Supabase through its connection string, RDS, Cloud SQL, AlloyDB, or on-premises. Tables live in a configurable private schema (default `melchizedek`), so no anon REST path exists.
3. **Schema changes are numbered, idempotent migrations** in `db/migrations/`, shipped in the package and applied by `melchizedek db migrate`. A version table lets the server refuse a schema it does not match. The Markdown copies of the schema are generated from these files.

> **Note (2026-10-01):** The migrations create their tables in the `public` schema, so the configurable private schema is not built yet and `db/hardening.sql` still applies. They are applied with `melchizedek-db apply` (`npm run db -- apply`), and the server does not yet check `melchizedek_schema_version`, see [ADR 0026](/decisions/0026-governance-policy-and-visibility.md).
4. **Topology follows configuration.** With in-memory defaults the supported deployment is one instance. With Postgres storage plugged in, multiple instances are supported. Health and readiness routes and a draining shutdown exist in both.
5. **Redis is an optional adapter for the limits plug point only,** for request rates Postgres counters do not suit. An adopter may also set limits off and let an API gateway enforce them.
6. **`supabase-js` storage is deprecated.** It stays for one transition period, then is removed.

> **Note (2026-10-01):** No Redis adapter exists yet, and supabase-js storage is still the server's default whenever Supabase credentials are set and `DATABASE_URL` is not, see [ADR 0017](/decisions/0017-plug-points.md).

## Alternatives considered

- **Redis for tasks, locks and limits beside Postgres.** Rejected as a requirement: it adds a second datastore to provision, secure and back up for modest volumes, since agent turns take seconds and cost money. Kept as an option.
- **Keep supabase-js and make the schema configurable.** Rejected: it keeps the anon-exposure class of risk and still excludes plain Postgres.
- **ADK's `DatabaseSessionService`.** Rejected as the adapter: its ORM brings five SQL drivers. It is a useful reference for the row-per-event shape.

## Consequences

- `db/hardening.sql` matters only to deployments that still expose a Supabase REST layer. On the pg adapter the private schema and grants are part of the migrations.
- Edge and serverless runtimes that cannot hold a TCP connection need a pooler or the deprecated adapter.
- The scheduled prunes (sessions, ledger) and the erase operation run over the same connection.
