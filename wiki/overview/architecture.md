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
    title: '§5 repository directory, §12 why subagents'
---

# Architecture

## The spine

A syndicate run is four hand-offs:

1. **`lib/loadSyndicate.ts`** reads a YAML from `config/agents/`, confines the path, interpolates `{{token}}` bindings (a fresh `current_date` is always injected), and returns typed config. It deliberately does not resolve tools.
2. **`lib/toolRegistry.ts`** maps declared tool-name strings to live instances — unknown names degrade to a warning, not an error. Agents with `mcp_server_url` additionally discover remote tools at runtime ([MCP](/protocols/mcp.md)).
3. **`lib/models/registry.ts`** routes each agent's `model:` string to a provider adapter ([provider routing](/models/provider-routing.md)); every adapter emits the same `llm.request` telemetry spans.
4. An ADK `LlmAgent` graph is assembled — subagents wrapped as `AgentTool`s under the orchestrator — and run by an entrypoint: the REPL (`scripts/syndicate_chat.ts`), the [A2A server](/protocols/a2a.md), or a custom script.

Persistence is opt-in per syndicate (`memory_system:`): sessions in Supabase, plus [long-term memory](/memory/architecture.md) on the [canonical schema](/memory/schema.md).

## Why subagents at all

Condensed from the design essay in DOCUMENTATION.md §12 — five structural advantages over one agent holding every tool:

1. **Less tool fatigue.** An agent choosing among many tools mis-selects and mis-parameterizes more; scoping each subagent to its domain's tools shrinks the search space.
2. **No narrative drift.** Subagents work in isolation and cannot see each other's findings, so an early bullish/bearish/etc. bias in one lane cannot contaminate the others; the orchestrator must reconcile genuinely independent assessments.
3. **Prompt clarity.** Three focused instructions beat one diluted mega-persona; each is debuggable on its own.
4. **Per-role hyperparameters.** Data-gathering runs cold (t≈0.2), synthesis warmer (t≈0.5–0.7) — impossible with a single agent's single temperature.
5. **Observability.** When the conclusion is wrong, intermediate subagent outputs show whether retrieval, analysis, or synthesis failed.

The syndicate catalog in [/agents/](/agents/) shows the pattern at every scale, from two-role debate ([Agora Council](/agents/agora.md)) to tool-discovering MCP teams ([Lyceum Librarian](/agents/librarian.md)).
