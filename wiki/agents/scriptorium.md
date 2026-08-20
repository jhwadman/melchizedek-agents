---
type: syndicate
title: The Scriptorium
description: "Keeper of the knowledge bundle: answers what the house knows via the Seeker, records what it learns via the Illuminator."
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/scriptorium.yaml
---

# The Scriptorium

<!-- wiki:fill slot="charter" -->
The Scriptorium maintains the framework's knowledge bundle (see [/meta/wiki-system.md](/meta/wiki-system.md)). It exists to serve as the conversational staff that answers questions from the bundle and records new learnings. Guided by the Armarius orchestrator, the syndicate excels at querying knowledge with path citations via the Seeker subagent and authoring or revising markdown documents through a validated save gate via the Illuminator subagent. All assertions rely strictly on the bundle as the sole source of truth.

Run `npm run syndicate:scriptorium` when visitors need to query what the house knows or record new framework concepts, editorial revisions, or architectural decisions into the knowledge graph.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/scriptorium.yaml" -->
Run: `npm run syndicate:scriptorium`

- memory: `internal-only`
- orchestrator: **Armarius** (`gemini-3.7-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Seeker | `gemini-3.1-flash-lite` | `wiki_map`, `wiki_search`, `wiki_read`, `wiki_links`, `wiki_dive` | — |
| Illuminator | `gemini-3.7-flash` | `wiki_map`, `wiki_search`, `wiki_read`, `wiki_links`, `wiki_save` | — |
<!-- /wiki:generated -->
