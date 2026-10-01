---
type: syndicate
title: Delegation Router Workflow
description: The Delegation Router Workflow syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/delegation.yaml
---

# Delegation Router Workflow

<!-- wiki:fill slot="charter" -->
The Delegation Router Workflow exists to triage user requests and delegate them to specialized subagents rather than answering specialized queries directly. RouterAgent reads each specialist's `description` and hands the turn to one of them: code to write or explain goes to CodeExpert, and a number, solution, derivation or proof goes to MathExpert. A question that is both goes by its deliverable. RouterAgent answers greetings, small talk and short questions in the `domain` variable (general knowledge as shipped) itself, and relays a specialist's answer in full. It calls one specialist per turn, never both. The relay turn is the cost of delegation; [Research](/agents/research.md) and [Support Triage](/agents/support_triage.md) show the `dispatch:` version, where code runs the chosen route and the specialist's answer is the reply.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/delegation.yaml" -->
Run: `npm run syndicate:delegation`

- memory: `session-only`
- orchestrator: **RouterAgent** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| CodeExpert | `gemini-3.8-flash` | — | — |
| MathExpert | `gemini-3.8-flash` | — | — |
<!-- /wiki:generated -->
