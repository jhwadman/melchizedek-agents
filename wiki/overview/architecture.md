---
type: subsystem
title: Architecture
description: The moving parts — loader, registries, adapters, persistence — and the five reasons the work is split across subagents instead of one omniscient agent.
tags:
  - overview
  - architecture
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: DOCUMENTATION.md
    title: '§1 Architecture'
  - resource: lib/loadSyndicate.ts
  - resource: lib/runtime/syndicateTurn.ts
---

# Architecture

## The spine

A syndicate run is four hand-offs:

1. **`lib/loadSyndicate.ts`** reads a YAML from the agents directory (`config/agents/`, or `MELCHIZEDEK_AGENTS_DIR`; a name missing at its root is looked up in `examples/`, then `templates/`), confines the path, interpolates `{{token}}` bindings (a fresh `current_date` is always injected), and validates the result against the zod schema in `lib/syndicateSchema.ts` (unknown keys, types and dispatch targets fail with their key path). It deliberately does not resolve tools.
2. **`lib/toolRegistry.ts`** maps declared tool-name strings to live instances — unknown names degrade to a warning, not an error. Agents with `mcp_server_url` additionally discover remote tools at runtime ([MCP](/protocols/mcp.md)).
3. **`lib/models/registry.ts`** routes each agent's `model:` string to a provider adapter ([provider routing](/models/provider-routing.md)); every adapter emits the same `llm.request` telemetry spans.
4. **`lib/runtime/syndicateTurn.ts`** runs the turn: `lib/compile.ts` assembles the ADK `LlmAgent` graph (subagents as `AgentTool`s, or remote [A2A](/protocols/a2a.md) agents), plan-dispatch picks a route when the syndicate declares one, guards run on the answer, and `lib/runtime/turnControl.ts` holds the turn-wide step cap, deadline and cancel. Every surface calls it — the REPL (`scripts/syndicate_chat.ts`), the [A2A server](/protocols/a2a.md), the background worker (`scripts/assistant_worker.ts`) and any embedding application — so a syndicate behaves the same wherever it runs ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)).

Persistence is opt-in per syndicate (`memory_system:` — `internal-only`, `session-only` or `long-term`) and needs a configured store — Supabase for every surface, or Postgres via `DATABASE_URL` for the [A2A server](/protocols/a2a.md): `session-only` keeps durable sessions, `long-term` adds [long-term memory](/memory/architecture.md) on the [canonical schema](/memory/schema.md). Without a store, sessions live in process memory and the surface says so.

## Why subagents at all

Five structural advantages over one agent holding every tool:

1. **Less tool fatigue.** An agent choosing among many tools mis-selects and mis-parameterizes more; scoping each subagent to its domain's tools shrinks the search space.
2. **No narrative drift.** Subagents work in isolation and cannot see each other's findings, so an early bullish/bearish/etc. bias in one lane cannot contaminate the others; the orchestrator must reconcile genuinely independent assessments.
3. **Prompt clarity.** Three focused instructions beat one diluted mega-persona; each is debuggable on its own.
4. **Per-role hyperparameters.** Data-gathering runs with thinking off and a tight output cap, synthesis with a MEDIUM thinking level and room to reason — impossible with a single agent's single config. (Where a provider still exposes sampling, temperature is per-role too; current Gemini models take none.)
5. **Observability.** When the conclusion is wrong, intermediate subagent outputs show whether retrieval, analysis, or synthesis failed.

The syndicate catalog in [/agents/](/agents/) shows the pattern at every scale, from two-role debate ([Council](/agents/council.md)) to tool-discovering MCP teams ([Lyceum Librarian](/agents/librarian.md)).
