---
type: syndicate
title: Systems Operator
description: The Systems Operator syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/systems_operator.yaml
---

# Systems Operator

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/systems_operator.yaml" -->
- memory: `session-only` · max_steps: 16
- orchestrator: **Operator** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Systems | `gemini-3.8-flash` | — | `mcp_server_url` |
<!-- /wiki:generated -->
