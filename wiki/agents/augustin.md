---
type: syndicate
title: Augustin
description: The Augustin syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/augustin.yaml
---

# Augustin

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/augustin.yaml" -->
Run: `npm run syndicate:augustin`

- memory: `session-only`
- orchestrator: **Arbiter** (`gemini-3.7-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| XResearcher | `grok-4.5` | `x_search`, `web_extract` | — |
| WebResearcher | `gemini-3.7-flash` | `web_search`, `web_extract` | — |
<!-- /wiki:generated -->
