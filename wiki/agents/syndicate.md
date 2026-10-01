---
type: syndicate
title: Global Synthesis Council
description: The Global Synthesis Council syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/syndicate.yaml
---

# Global Synthesis Council

<!-- wiki:fill slot="charter" -->
The Global Synthesis Council is the simplest delegation specimen in the starter pack: a Melchizedek orchestrator that must consult its NewsResearcher subagent before it writes. NewsResearcher makes at most three `google_search` calls for news published on `{{current_date}}` or the two days before, returns at most `headline_count` items (5 as shipped), each with its outlet and date, and says `NO NEWS FOUND` rather than filling a gap. The orchestrator then writes a dated synthesis of three to four paragraphs, at most 350 words, built only from what the researcher returned. Run it to see the plainest orchestrator-and-subagent delegation, and read it as the shape the later examples elaborate. For other workflows, see the [Agents](/agents/index.md) directory.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/syndicate.yaml" -->
Run: `npm run syndicate:synthesis`

- memory: `session-only`
- orchestrator: **Melchizedek** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| NewsResearcher | `gemini-3.1-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->
