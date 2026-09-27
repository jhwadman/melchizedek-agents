---
type: syndicate
title: Case Desk
description: The Case Desk syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/case_desk.yaml
---

# Case Desk

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/case_desk.yaml" -->
- memory: `session-only` · max_steps: 16
- orchestrator: **CaseLead** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Runbooks | `gemini-3.1-flash-lite` | `wiki_search`, `wiki_read`, `wiki_links` | — |
| Reader | `gemini-3.1-flash-lite` | `web_extract` | — |
<!-- /wiki:generated -->
