---
type: syndicate
title: Research Brief
description: The Research Brief syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/research_brief.yaml
---

# Research Brief

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/research_brief.yaml" -->
- memory: `internal-only` · max_steps: 30
- orchestrator: **Editor** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| ResearchDesk | `default` | — | — |
| Writer | `gemini-3.8-flash` | — | — |
| Verifier | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
