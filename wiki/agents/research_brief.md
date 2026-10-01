---
type: syndicate
title: Research Brief
description: The Research Brief syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/templates/research_brief.yaml
---

# Research Brief

<!-- wiki:fill slot="charter" -->
Research Brief is the multi-layer orchestration template. It returns a decision-ready brief on one question (a vendor, a market, a regulation, a technology) in five labelled sections: ANSWER, WHAT WE KNOW, WHERE SOURCES DISAGREE, WHAT WE COULD NOT ESTABLISH and SOURCES. Every claim ends with a `[n]` that points to the page it came from.

It is three layers deep. The Editor plans, routes and decides what is published, and never researches or rewords prose. Its ResearchDesk subagent is a whole nested syndicate, `yaml_reference: research_desk.yaml` ([Research Desk](/agents/research_desk.md)), which runs its own Scout and Reader; the Editor sees it as one tool. The Writer turns the desk's notes into the brief and has no tools. The Verifier checks the draft against the same notes and has no tools either, so it cannot "verify" a claim by finding a different page that agrees.

The run is bounded: at most two desk calls, two Writer calls and one Verifier call. A FIX from the Verifier sends the draft back to the Writer once, and that revision ships unchecked. The brief's last line, CHECKED, says which of these happened. When the desk finds nothing, the Editor publishes a fixed no-findings brief built from the desk's GAPS. Memory is `internal-only`. Serve it with `npm run start:a2a` and POST the question to `/research_brief/a2a/rest/v1/message:send`. To change the research source, change the one `yaml_reference` line.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/research_brief.yaml" -->
- memory: `internal-only` · max_steps: 30
- orchestrator: **Editor** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| ResearchDesk | syndicate: [research_desk](/agents/research_desk.md) | — | — |
| Writer | `gemini-3.8-flash` | — | — |
| Verifier | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
