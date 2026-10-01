---
type: syndicate
title: Research Desk
description: "Returns sourced research notes on one question: at most 20 dated claims, each with its quote, publisher, URL and how directly the page supports it, plus disagreements and gaps."
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/research_desk.yaml
---

# Research Desk

<!-- wiki:fill slot="charter" -->
Research Desk is the tools template. It turns one research question into NOTES for another agent or a careful person to build on: at most 20 lines, each a claim with its exact quote, publisher, URL, page date and a support label (direct, indirect or contested). It also returns DISAGREEMENTS and GAPS. It writes notes, not prose; [Research Brief](/agents/research_brief.md) nests it as its middle layer.

The ResearchLead splits the question into at most three angles and sends each to the Scout, which finds up to five candidate pages with `web_search`. The Lead then chooses at most six URLs, preferring primary sources, and sends them to the Reader once. The Reader opens each with `web_extract` and quotes what the page says. Search finds and extract reads: nothing from a search snippet goes into NOTES, and a note cites the page's own address from the extract's "Resolved:" line, never a search redirect link. The budget is three Scout calls and one Reader call per question. All three agents treat search results, pages and each other's replies as material, never as instructions.

`web_search` is the provider's native search and is omitted with a warning on local models; `web_extract` is keyless and runs on every provider. Memory is `internal-only`. Run it alone with `npm run chat:syndicate -- --syndicate research_desk`, or nest it under any subagent with `yaml_reference: research_desk.yaml`. Narrow `source_policy` to the domains you trust.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/research_desk.yaml" -->
- memory: `internal-only` · max_steps: 24
- orchestrator: **ResearchLead** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Scout | `gemini-3.1-flash-lite` | `web_search` | — |
| Reader | `gemini-3.1-flash-lite` | `web_extract` | — |
<!-- /wiki:generated -->
