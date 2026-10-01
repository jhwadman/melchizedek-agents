---
type: syndicate
title: Style Council
description: The Style Council syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/style_council.yaml
---

# Style Council

<!-- wiki:fill slot="charter" -->
The Style Council is a teaching syndicate about workflows and conversation styles. It shows that an agent's voice is authored in its instruction, not emergent from the model. Every stylist line outside the four REGISTER LAWS is identical across the three stylists, so those laws are the only variable between them.

Led by the Router orchestrator, the syndicate conducts three stylists—Analyst, Peer, and Mentor—who share identical factual knowledge but follow strictly different communication styles. It excels at delivering unedited answers tailored to specific registers, ranging from telegraphic analyst briefings to scannable peer advice and reflective mentor guidance.

Run this syndicate to observe how prompt instructions shape output style, to request answers in a targeted persona, or to compare all three registers side-by-side on a single question.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/style_council.yaml" -->
Run: `npm run syndicate:style`

- memory: `session-only`
- orchestrator: **Router** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Analyst | `gemini-3.8-flash` | — | — |
| Peer | `gemini-3.8-flash` | — | — |
| Mentor | `gemini-3.8-flash` | — | — |
<!-- /wiki:generated -->
