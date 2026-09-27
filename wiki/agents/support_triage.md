---
type: syndicate
title: Support Triage
description: The Support Triage syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/support_triage.yaml
---

# Support Triage

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/support_triage.yaml" -->
- memory: `session-only` · max_steps: 12
- orchestrator: **Triage** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| answer | `gemini-3.1-flash-lite` | `wiki_search`, `wiki_read`, `wiki_links` | — |
| account | `gemini-3.8-flash` | — | `mcp_server_url` |
| handoff | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
