---
type: syndicate
title: Global Synthesis Council
description: The Global Synthesis Council syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/syndicate.yaml
---

# Global Synthesis Council

<!-- wiki:fill slot="charter" -->
The Global Synthesis Council is the earliest specimen in the starter pack: a Melchizedek orchestrator that must consult its NewsResearcher subagent before it writes. NewsResearcher searches for the current day's news (anchored to `{{current_date}}`), returns a counted headline list, and says `NO NEWS FOUND` rather than filling a gap. The orchestrator then writes a dated synthesis of three to four paragraphs, at most 350 words, built only from what the researcher returned. Run it to see the plainest orchestrator-and-subagent delegation, and read it as the shape the later examples elaborate. For other workflows, see the [Agents](/agents/index.md) directory.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/syndicate.yaml" -->
Run: `npm run syndicate:synthesis`

- memory: `session-only`
- orchestrator: **Melchizedek** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| NewsResearcher | `gemini-3.1-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->
