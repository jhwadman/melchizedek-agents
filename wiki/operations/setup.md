---
type: runbook
title: Setup paths
description: Three ways in — local REPL in five minutes, keyless local models via Ollama, or the A2A HTTP server toward cloud deployment — and which keys each one actually needs.
tags:
  - operations
  - setup
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: QUICKSTART.md
  - resource: .env.example
---

# Setup paths

Prereq everywhere: Node ≥ 22.6 (`--experimental-strip-types` runs the TypeScript directly; the npm package runs compiled JS), `npm install`, and a `.env` — `lib/loadEnv.ts` reads the one in the directory you run from, then the repo's own; real env vars always win, and `.env.example` placeholders (`your_..._here`) are ignored, so copying the template sets nothing.

## Path A — local REPL (~5 min)

A Google AI Studio key (`GOOGLE_GENAI_API_KEY`) is the only requirement for the Gemini-default syndicates. `npm run chat:syndicate` starts the REPL; each syndicate has an `npm run syndicate:<name>` alias — the catalog with run commands is generated per-team in [/agents/](/agents/).

Not sure which keys the syndicates you want actually need? `npm run doctor` reads every YAML, resolves each model under your `.env`, and prints what is ready, what is blocked, and which variable unlocks what — read-only, no key value shown ([provider routing](/models/provider-routing.md)).

## Path A′ — keyless and local

With [Ollama](https://ollama.com) serving `qwen3:8b` (the smallest pulled model with tool calling), syndicates declaring `ollama/*` models — like the [Council](/agents/council.md) — run with **no API key at all**. Other providers activate per key: `ANTHROPIC_API_KEY` for `claude-*`, `OPENAI_API_KEY` for `gpt-*`, `XAI_API_KEY` for `grok-*` ([provider routing](/models/provider-routing.md)); a missing key just logs the provider as disabled.

## Path A″ — one key for every cloud provider

`MODEL_GATEWAY=vercel` (or `openrouter`) with `MODEL_GATEWAY_API_KEY` serves any cloud model id whose direct key is absent through that gateway. It is a fallback: a direct key set beside it always wins for its own provider, so adding `GOOGLE_GENAI_API_KEY` later restores Gemini grounding with no YAML change. Native search is lost on the gateway path and the doctor says so per agent ([ADR 0012](/decisions/0012-direct-adapters-canonical.md)).

## Path B — A2A HTTP server (~15 min)

`npm run start:a2a -- <syndicate>.yaml` on `$PORT` (default 4000). The server's own keys pay unless `A2A_KEY_MODE=byok`; `A2A_AUTH` picks how callers authenticate (shared secret, per-caller tokens, JWT or a gateway header, [ADR 0025](/decisions/0025-built-in-authenticators.md)); with no credential configured it binds `127.0.0.1` only. The boot log names the URLs, the auth mode and the session backend — the contract is in [A2A](/protocols/a2a.md).

## Path C — cloud (~30 min)

The public package ships a `Dockerfile` (compiled server, non-root, health check) and a `compose.yaml`; this deployment runs the same server on Heroku-style dynos. Pair it with Supabase for sessions and [memory](/memory/architecture.md): `npm run db -- apply` (or `print` into the SQL editor) installs the migrations in `db/migrations/` and the hardening, and `npm run db -- status` checks them. Probes go to `/healthz` and `/readyz`; SIGTERM drains running tasks for `A2A_SHUTDOWN_GRACE_MS`. Tasks and the config cache are per process, so run one replica until the task store is durable ([ADR 0021](/decisions/0021-postgres-first-storage.md)).

Model choice guidance and the errors you will actually hit: [failure modes](/operations/failure-modes.md).
