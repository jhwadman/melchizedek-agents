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

Prereq everywhere: Node ≥ 22 (`--experimental-strip-types` runs the TypeScript directly), `npm install`, and a `.env` at the repo root (loaded by `lib/loadEnv.ts`; real env vars always win over the file).

## Path A — local REPL (~5 min)

A Google AI Studio key (`GOOGLE_GENAI_API_KEY`) is the only requirement for the Gemini-default syndicates. `npm run chat:syndicate` starts the REPL; each syndicate has an `npm run syndicate:<name>` alias — the catalog with run commands is generated per-team in [/agents/](/agents/).

## Path A′ — keyless and local

With [Ollama](https://ollama.com) serving `qwen3:8b` (the smallest pulled model with tool calling), syndicates declaring `ollama/*` models — like the [Agora Council](/agents/agora.md) — run with **no API key at all**. Other providers activate per key: `ANTHROPIC_API_KEY` for `claude-*`, `OPENAI_API_KEY` for `gpt-*`, `XAI_API_KEY` for `grok-*` ([provider routing](/models/provider-routing.md)); a missing key just logs the provider as disabled.

## Path B — A2A HTTP server (~15 min)

`npm run start:a2a -- <syndicate>.yaml` on `$PORT` (default 4000). Callers bring their own model key per request; set `A2A_SERVER_SECRET` before exposing it anywhere — the contract is in [A2A](/protocols/a2a.md).

## Path C — cloud (~30 min)

The `Procfile` targets Heroku-style dynos running the A2A server; pair with Supabase for sessions, [memory](/memory/architecture.md), and the agent registry — apply the [canonical schema](/memory/schema.md) in the Supabase SQL editor first (`SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` in the environment).

Model choice guidance and the errors you will actually hit: [failure modes](/operations/failure-modes.md).
