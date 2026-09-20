---
type: syndicate
title: Augustin Desk (deep)
description: The Augustin Desk (deep) syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-08
sources:
  - resource: config/agents/augustin_desk_deep.yaml
---

# Augustin Desk (deep)

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/augustin_desk_deep.yaml" -->
- memory: `session-only`
- orchestrator: **Arbiter** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| XScout | `grok-4.5` | `x_search`, `web_extract` | — |
| WebCheck | `gemini-3.8-flash` | `web_search`, `web_extract` | — |
<!-- /wiki:generated -->
