---
type: syndicate
title: Delegation Router Workflow
description: The Delegation Router Workflow syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/delegation.yaml
---

# Delegation Router Workflow

<!-- wiki:fill slot="charter" -->
The Delegation Router Workflow exists to triage user requests and delegate them to specialized subagents rather than answering specialized queries directly. Led by RouterAgent, this syndicate excels at identifying query domains: it routes programming, software development, and debugging questions to CodeExpert, while directing mathematics, formula, and calculation queries to MathExpert. RouterAgent handles general greetings or unrelated topics directly with concise responses. Run this syndicate when processing incoming requests that require automated triage and delegation across specialized coding and mathematical [agents](/agents/index.md).
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/delegation.yaml" -->
Run: `npm run syndicate:delegation`

- memory: `session-only`
- orchestrator: **RouterAgent** (`gemini-3.7-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| CodeExpert | `gemini-3.7-flash` | — | — |
| MathExpert | `gemini-3.7-flash` | — | — |
<!-- /wiki:generated -->
