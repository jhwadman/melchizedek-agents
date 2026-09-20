---
type: syndicate
title: Augustin Desk
description: The Augustin Desk syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-08
sources:
  - resource: config/agents/augustin_desk.yaml
---

# Augustin Desk

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/augustin_desk.yaml" -->
- memory: `session-only`
- orchestrator: **Triage** (`gemini-3.5-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| world | `gemini-3.5-flash-lite` | `web_search`, `web_extract` | — |
| arbiter | `default` | — | — |
<!-- /wiki:generated -->
