---
type: syndicate
title: Augustin
description: The Augustin syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/augustin.yaml
---

# Augustin

<!-- wiki:fill slot="charter" -->
Augustin is a fact-checking arbiter of world events. The user brings an event, a controversy or a claim, and the syndicate returns the narrative as far as the record supports one: a conversational lead, then the load-bearing facts as sourced bullets. Its shape is an arbiter pattern (X sweep, then web validation, then tool-free arbitration) in one DELEGATE syndicate. The Arbiter must consult both researchers on every substantive question, X first and the web second, and builds the answer from their two reports alone. The researchers collect and never interpret; the Arbiter never collects. A claim stands as bare fact only when both channels support it or a primary source confirms it.

XResearcher reads X through `x_api_search`, a client-side tool over the X API v2 recent search: one page of the last seven days per query, with every attached photo transcribed beneath its post by a Gemini vision pass. The X channel therefore runs on any provider; it needs `X_BEARER_TOKEN` in the server environment. Text read from a picture enters the record as the image's word, single-source until WebResearcher confirms it. WebResearcher validates with `web_search` and `web_extract`. Callers prefix each message with the current date and keep one `contextId` per conversation. A deployment may serve its own edited copy from the agent registry as `registry:augustin` ([ADR 0018](/decisions/0018-files-are-the-source-of-truth.md)).
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/augustin.yaml" -->
Run: `npm run syndicate:augustin`

- memory: `session-only`
- orchestrator: **Arbiter** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| XResearcher | `gemini-3.8-flash` | `x_api_search`, `web_extract` | — |
| WebResearcher | `gemini-3.8-flash` | `web_search`, `web_extract` | — |
<!-- /wiki:generated -->
