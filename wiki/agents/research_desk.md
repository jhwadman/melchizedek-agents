---
type: syndicate
title: Research Desk
description: "Returns sourced research notes on one question: dated claims, each with the URL it rests on and how directly the page supports it."
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/research_desk.yaml
---

# Research Desk

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/research_desk.yaml" -->
- memory: `internal-only` · max_steps: 24
- orchestrator: **ResearchLead** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Scout | `gemini-3.1-flash-lite` | `web_search` | — |
| Reader | `gemini-3.1-flash-lite` | `web_extract` | — |
<!-- /wiki:generated -->
