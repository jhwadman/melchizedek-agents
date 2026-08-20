---
type: syndicate
title: The Cartographers
description: "Maps the knowledge graph: has the Surveyor read prose for relations a parser cannot see, and the Registrar record them with their evidence."
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/cartographers.yaml
---

# The Cartographers

<!-- wiki:fill slot="charter" -->
The Cartographers keep the half of the [knowledge graph](/meta/knowledge-graph.md) that cannot draw itself. Structural relations are derived from repo truth on every build — who calls which tool, which model routes to which provider, what a module imports. What no parser can see is the judgment written in prose: that a decision constrains a pipeline, that a mechanism exists to contain a named failure, that two documents have drifted into contradiction. The Surveyor reads an area of the bundle and proposes those relations, each quoting the sentence that supports it; the Registrar records them one at a time through the `wiki_relate` gate, which refuses anything unevidenced, dangling, duplicated, or pointing from a public document into the private annex.

Run it after a decision lands, after a subsystem is documented, or when the graph census shows a region with no asserted relations at all. Its discipline is the tier rule: never assert what the build derives — a hand-written copy of a structural fact freezes the moment the YAML changes, and this syndicate's whole value is that its edges stay true. An empty survey is a real result, and a rejected proposal is the gate working.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/cartographers.yaml" -->
Run: `npm run syndicate:cartographers`

- memory: `internal-only`
- orchestrator: **Cosmographer** (`gemini-3.7-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Surveyor | `gemini-3.7-flash` | `wiki_map`, `wiki_search`, `wiki_read`, `wiki_links`, `wiki_graph` | — |
| Registrar | `gemini-3.1-flash-lite` | `wiki_graph`, `wiki_read`, `wiki_relate` | — |
<!-- /wiki:generated -->
