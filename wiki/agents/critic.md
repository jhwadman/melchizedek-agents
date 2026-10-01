---
type: syndicate
title: Critic Review Workflow
description: The Critic Review Workflow syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/critic.yaml
---

# Critic Review Workflow

<!-- wiki:fill slot="charter" -->
The Critic Review Workflow syndicate coordinates an iterative draft-and-review process to ensure only high-confidence answers reach the user. It delegates the user's question to a DrafterAgent and routes each draft to a CriticAgent. The Critic is a leaf with no tools that holds the `outputSchema`: it returns JSON with a polished `message`, a `confidence` score from 0 to 100, and an `issues` list. The schema sits on the leaf because an ADK agent cannot hold both an `outputSchema` and AgentTools.

The loop runs within a single user-facing turn. If the confidence score is below 85, the ReviewOrchestrator sends the Critic's issues back to the DrafterAgent for a revision, for at most three rounds. It then returns the Critic's latest JSON raw and unchanged. The Critic grades without tools, so it checks a draft only as far as the model can reason. Run this syndicate to see a graded draft-and-revise loop; [Draft Review](/agents/draft_review.md) is the production template with a policy checklist in place of the score.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/critic.yaml" -->
Run: `npm run syndicate:critic`

- memory: `session-only`
- orchestrator: **ReviewOrchestrator** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| DrafterAgent | `gemini-3.8-flash` | — | — |
| CriticAgent | `gemini-3.8-flash` | — | — |
<!-- /wiki:generated -->
