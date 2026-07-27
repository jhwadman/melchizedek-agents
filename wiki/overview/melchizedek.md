---
type: overview
title: Melchizedek
description: A pure Google ADK multi-agent orchestration framework — YAML-defined syndicates, five-provider model optionality, Supabase persistence and memory, MCP and A2A interop.
tags:
  - overview
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: README.md
  - resource: DOCUMENTATION.md
---

# Melchizedek

Melchizedek is a headless agent-orchestration framework built directly on `@google/adk`. An agent team — a **syndicate** — is one YAML file: an orchestrator, its subagents, their models, tools, and instructions. The framework loads that file, resolves every declared capability, and runs the team in a terminal REPL, behind an HTTP API, or inside another application.

Its parts, each documented in this bundle:

- [Architecture](/overview/architecture.md) — how the pieces fit, and why the work is divided among subagents at all.
- [Syndicates](/agents/) — one document per agent team, generated from the YAML truth.
- [Tool contracts](/tools/tool-contracts.md) — define a tool once (zod), serve it to agents and MCP clients alike; see the [tool layer](/tools/).
- [Provider routing](/models/provider-routing.md) — `model:` strings route across Gemini, Claude, GPT, Grok, and local Ollama; availability follows API keys.
- [Memory](/memory/architecture.md) — session transcripts distilled into supersedable facts with hybrid vector recall, on the [canonical schema](/memory/schema.md).
- [MCP](/protocols/mcp.md) and [A2A](/protocols/a2a.md) — reaching tools outward and serving agents outward.
- [Operations](/operations/) — [setup paths](/operations/setup.md), [failure modes](/operations/failure-modes.md), and the [public export pipeline](/operations/export-pipeline.md).

The repo is the private source of truth for a three-repo network — a sanitized public mirror and a teaching site derive from it; see [the Lyceum network](/overview/lyceum-network.md).

This bundle is itself a subsystem: an [OKF knowledge bundle](/meta/wiki-system.md) built and gardened by the framework's own tools.
