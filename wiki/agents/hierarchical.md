---
type: syndicate
title: Hierarchical Task Decomposition
description: The Hierarchical Task Decomposition syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/hierarchical.yaml
---

# Hierarchical Task Decomposition

<!-- wiki:fill slot="charter" -->
The Hierarchical Task Decomposition syndicate handles complex user goals by breaking them down into logical sub-tasks. Managed by a ProjectManager orchestrator, the syndicate coordinates specialized subagents rather than answering directly. It separates research from writing: the ResearcherAgent finds facts with `google_search`, one question per call and at most three, and returns cited notes with a NOT FOUND line for anything the search did not answer. The WriterAgent writes the deliverable from those notes and adds no fact. The ProjectManager then checks the text against the notes and restores any changed figure or dropped NOT FOUND. In a chain, an error at stage one arrives downstream as fact, which is why each stage cites or admits a gap. Run this syndicate when a task needs facts gathered first and then turned into one finished response.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/hierarchical.yaml" -->
Run: `npm run syndicate:hierarchical`

- memory: `session-only`
- orchestrator: **ProjectManager** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| ResearcherAgent | `gemini-3.8-flash` | `google_search` | — |
| WriterAgent | `gemini-3.8-flash` | — | — |
<!-- /wiki:generated -->
