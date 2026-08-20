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
The Ares Data Extractor syndicate exists to exercise the persistent memory pipeline and prove that the Firebase SessionService and Vertex MemoryService are wired end-to-end through the CLI. Serving as a knowledge keeper for the War Council, Ares excels at accumulating facts across conversations to provide continuity, recall user preferences, reference prior discussions, and build upon past insights. It automatically receives preloaded memory context in requests and explicitly calls `load_memory` for deeper recall. Run this syndicate when you need persistent conversation continuity, long-term memory retrieval, or real-time research delegated to the WarScribe subagent.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/ares.yaml" -->
Run: `npm run syndicate:ares`

- memory: `long-term`
- orchestrator: **Ares** (`gemini-3.1-flash-lite`) · tools: `preload_memory`, `load_memory`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| WarScribe | `gemini-3.1-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->
