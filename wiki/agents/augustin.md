---
type: syndicate
title: Augustin
description: The Augustin syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-25
sources:
  - resource: config/agents/examples/augustin.yaml
---

# Augustin

<!-- wiki:fill slot="charter" -->
Augustin is the fact-checking arbiter of world events: the user brings an event, a controversy or a claim, and the syndicate returns the true narrative as far as the record supports one — a conversational lead, then the load-bearing facts as sourced bullets. It is melch-research's daily bias-arbiter pattern (X sweep → web validation → tool-free arbitration) folded into one live DELEGATE syndicate. The Arbiter MUST consult both researchers on every substantive question and builds the answer from their two reports alone; the collectors never interpret and the Arbiter never collects.

XResearcher reads X through `x_api_search` — the X API v2 recent search called directly, one dated page per query, every attached photo transcribed beneath its post by a Gemini vision pass — so the X channel runs on Gemini and needs `X_BEARER_TOKEN` in the server environment rather than a grok-* model and an XAI key (2026-09-20). What a picture says enters the record as the image's word: single-source until WebResearcher confirms it. Two copies since 2026-09-20 ([ADR 0011](/decisions/0011-private-live-syndicate-copy.md)): `config/agents/examples/augustin.yaml` is the public starter-pack copy this page is built from in the export; the deployment runs a gitignored private copy at `config/agents/augustin.yaml`, published to the agent registry under the bare id `augustin` with `scripts/deploy_agent.ts` plus a restart — the registry, not the slug, serves it. The two were seeded identical and may diverge.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/augustin.yaml" -->
Run: `npm run syndicate:augustin`

- memory: `session-only`
- orchestrator: **Arbiter** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| XResearcher | `gemini-3.8-flash` | `x_api_search`, `web_extract` | — |
| WebResearcher | `gemini-3.8-flash` | `web_search`, `web_extract` | — |
<!-- /wiki:generated -->
