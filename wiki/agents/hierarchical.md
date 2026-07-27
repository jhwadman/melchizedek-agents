---
type: syndicate
title: Hierarchical Task Decomposition
description: The Hierarchical Task Decomposition syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-27
sources:
  - resource: config/agents/hierarchical.yaml
---

# Hierarchical Task Decomposition

<!-- wiki:fill slot="charter" -->
The Hierarchical Task Decomposition syndicate handles complex user goals by breaking them down into logical sub-tasks. Managed by a ProjectManager orchestrator, the syndicate coordinates specialized subagents rather than answering directly. It excels at separating analytical work from content generation: the ResearcherAgent handles fact-gathering, calculations, and raw data analysis, while the WriterAgent handles formatting, synthesis, and creative writing. Run this syndicate when a task requires structured, multi-stage execution where raw research must be gathered and transformed into a cohesive final response.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/hierarchical.yaml" -->
Run: `npm run syndicate:hierarchical`

- memory: `session-only`
- orchestrator: **ProjectManager** (`gemini-3.6-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| ResearcherAgent | `gemini-3.6-flash` | `google_search` | — |
| WriterAgent | `gemini-3.6-flash` | — | — |
<!-- /wiki:generated -->
