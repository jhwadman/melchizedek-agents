---
type: syndicate
title: Account Memory
description: The Account Memory syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/account_memory.yaml
---

# Account Memory

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/account_memory.yaml" -->
- memory: `long-term` · max_steps: 12
- orchestrator: **AccountLead** (`gemini-3.8-flash`) · tools: `preload_memory`, `load_memory`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Writer | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
