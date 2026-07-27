---
type: syndicate
title: Global Synthesis Council
description: The Global Synthesis Council syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-27
sources:
  - resource: config/agents/syndicate.yaml
---

# Global Synthesis Council

<!-- wiki:fill slot="charter" -->
The Global Synthesis Council exists to synthesize current events and explain the overall direction the world is going in. Led by the Melchizedek orchestrator, the syndicate excels at fetching daily news, summarizing top headlines, and reasoning over collected facts to produce profound, multi-paragraph syntheses. It delegates web research to the NewsResearcher subagent, which retrieves real-world information using search tools. Run this syndicate when you need to gather recent news on specific topics, analyze ongoing world events, or evaluate overarching global trends across current headlines. For other specialized workflows, view the main [Agents](/agents/index.md) directory.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/syndicate.yaml" -->
Run: `npm run syndicate:council`

- memory: `session-only`
- orchestrator: **Melchizedek** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| NewsResearcher | `gemini-3.1-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->
