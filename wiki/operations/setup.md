---
type: runbook
title: Setup paths
description: Three ways in — local REPL in five minutes, keyless local models via Ollama, or the A2A HTTP server toward a container deployment — and which keys each one actually needs.
tags:
  - operations
  - setup
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: QUICKSTART.md
  - resource: .env.example
  - resource: scripts/a2a_server.ts
  - resource: scripts/db.ts
  - resource: Dockerfile
  - resource: compose.yaml
---

# Setup paths

Prereq everywhere: Node ≥ 22.6 (`--experimental-strip-types` runs the TypeScript directly; the npm package runs compiled JS), `npm install`, and a `.env` — `lib/loadEnv.ts` reads the one in the directory you run from, then the repo's own; real env vars always win, and `.env.example` placeholders (`your_..._here`) are ignored, so copying the template sets nothing.

## Path A — local REPL (~5 min)

A Google AI Studio key (`GOOGLE_GENAI_API_KEY`) is the only requirement for the Gemini-default syndicates. `npm run chat:syndicate` starts the REPL on the default syndicate, and `npm run chat:syndicate -- --syndicate <name>` runs any other (`npx melchizedek-chat --syndicate <name>` from the installed package); most starter-pack syndicates also have an `npm run syndicate:<name>` alias — the catalog with run commands is generated per-team in [/agents/](/agents/).

Not sure which keys the syndicates you want actually need? `npm run doctor` (`npx melchizedek-doctor`) reads every YAML the loader can see, resolves each model under your `.env`, and prints what is ready, what is blocked, and which variable unlocks what — read-only, no key value shown ([provider routing](/models/provider-routing.md)).

## Path A′ — keyless and local

With [Ollama](https://ollama.com) serving `qwen3:8b` (the smallest pulled model with tool calling), syndicates declaring `ollama/*` models — like the [Council](/agents/council.md) — run with **no API key at all**. Other providers activate per key: `ANTHROPIC_API_KEY` for `claude-*`, `OPENAI_API_KEY` for `gpt-*`, `XAI_API_KEY` for `grok-*` ([provider routing](/models/provider-routing.md)); a missing key just logs the provider as disabled.

## Path A″ — one key for every cloud provider

`MODEL_GATEWAY=vercel` (or `openrouter`) with `MODEL_GATEWAY_API_KEY` serves any cloud model id whose direct key is absent through that gateway. It is a fallback: a direct key set beside it always wins for its own provider, so adding `GOOGLE_GENAI_API_KEY` later restores Gemini grounding with no YAML change. Native search is lost on the gateway path and the doctor says so per agent ([ADR 0012](/decisions/0012-direct-adapters-canonical.md)).

## Path B — A2A HTTP server (~15 min)

`npm run start:a2a -- <syndicate>.yaml` (`npx melchizedek-serve <syndicate>.yaml` from the installed package; default `syndicate.yaml`) on `$PORT` (default 4000). The server's own keys pay unless `A2A_KEY_MODE=byok`; `A2A_AUTH` picks how callers authenticate (shared secret, per-caller tokens, JWT or a gateway header, [ADR 0025](/decisions/0025-built-in-authenticators.md)). With no credential configured it binds `127.0.0.1` only, and it refuses to start on a non-loopback `HOST` (unless `ALLOW_UNAUTHENTICATED=true`) or with `PUBLIC_URL` set. The boot log names the URLs, the auth mode and the storage backend — the contract is in [A2A](/protocols/a2a.md).

## Path C — a container (~30 min)

The repository ships a `Dockerfile` (a two-stage build of the compiled server, run as the non-root `node` user, with a `/healthz` health check; the entrypoint is `dist/scripts/a2a_server.js`, so the container's argument is the syndicate file) and a `compose.yaml` (the server with `./config/agents` mounted read-only, plus an optional Ollama under the `local-models` profile and an optional Phoenix trace viewer under `traces`). Configuration is environment only, from `.env`: a server bound to `0.0.0.0` needs `A2A_SERVER_SECRET` (or another `A2A_AUTH` credential), and a public deployment sets `PUBLIC_URL`, which also makes the server refuse a Supabase schema without `db/hardening.sql` (unless `ALLOW_UNHARDENED_DB=true`). Without a container, `npx melchizedek-serve <syndicate>.yaml` runs the same server from the package.

Storage: set `DATABASE_URL` and every durable store — sessions, [memory](/memory/architecture.md), A2A tasks, daily budgets — lives in one Postgres with pgvector (Supabase's connection string works), shared by every instance ([ADR 0021](/decisions/0021-postgres-first-storage.md)). Without it the server uses Supabase over its API when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, with tasks kept per process, else process memory; in both of those cases run one replica. The per-agent config cache and the rate-limit counters are per process in every mode, so a config change needs a restart of each instance. `npm run db -- apply` (`npx melchizedek-db apply`, through `psql` against `DATABASE_URL`; `print` writes the same SQL for the SQL editor) installs the migrations in `db/migrations/` and then `db/hardening.sql`, and `npm run db -- status` checks them over the Supabase API. Probes go to `/healthz` and `/readyz`; SIGTERM drains running tasks for `A2A_SHUTDOWN_GRACE_MS` (default 25 s), so give the orchestrator's stop timeout at least that long.

Model choice guidance and the errors you will actually hit: [failure modes](/operations/failure-modes.md).
