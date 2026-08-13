---
type: syndicate
title: Style Council
description: The Style Council syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-13
sources:
  - resource: config/agents/style_council.yaml
---

# Style Council

<!-- wiki:fill slot="charter" -->
The Style Council is a teaching syndicate created for module 1.05 of the lyceumagents.com curriculum (Agent workflows & conversation styles). It proves that an agent's voice is authored through system instructions rather than emergent from the model itself.

Led by the Router orchestrator, the syndicate conducts three stylists—Analyst, Peer, and Mentor—who share identical factual knowledge but adhere to strictly different communication laws. It excels at delivering unedited answers tailored to specific registers, ranging from telegraphic analyst briefings to scannable peer advice and reflective mentor guidance.

Run this syndicate to observe how prompt instructions shape output style, to request answers in a targeted persona, or to compare all three registers side-by-side on a single question.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/style_council.yaml" -->
- memory: `session-only`
- orchestrator: **Router** (`gemini-3.7-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Analyst | `gemini-3.7-flash` | — | — |
| Peer | `gemini-3.7-flash` | — | — |
| Mentor | `gemini-3.7-flash` | — | — |
<!-- /wiki:generated -->
