---
type: syndicate
title: Ares Data Extractor
description: The Ares Data Extractor syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/ares.yaml
---

# Ares Data Extractor

<!-- wiki:fill slot="charter" -->
The Ares Data Extractor syndicate exists to exercise the long-term memory pipeline end to end: session events are distilled into dated, sourced records in Supabase (pgvector), and recalled on the next session through `preload_memory` and `load_memory`. Ares is a strategist for one user that answers from those records under a memory doctrine: records are the truth, an empty recall is said out loud ("I have nothing saved about that yet."), and newer records supersede older ones. Research it cannot answer from memory goes to the WarScribe subagent, which returns a capped, sourced briefing. Run it twice, telling it something in the first session and asking in the second, to watch a fact survive the process.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/ares.yaml" -->
Run: `npm run syndicate:ares`

- memory: `long-term`
- orchestrator: **Ares** (`gemini-3.1-flash-lite`) · tools: `preload_memory`, `load_memory`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| WarScribe | `gemini-3.1-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->
