---
type: syndicate
title: Critic Review Workflow
description: The Critic Review Workflow syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-27
sources:
  - resource: config/agents/critic.yaml
---

# Critic Review Workflow

<!-- wiki:fill slot="charter" -->
The Critic Review Workflow syndicate coordinates an iterative draft-and-review process to ensure only high-confidence answers reach the user. It delegates initial user queries to a DrafterAgent and routes drafts to a CriticAgent, which evaluates accuracy, clarity, and completeness while returning a structured JSON response with a confidence score.

This syndicate excels at autonomous answer refinement within a single user-facing turn. If the CriticAgent's confidence score is below 85, the ReviewOrchestrator automatically sends the Critic's feedback back to the DrafterAgent for revisions, looping up to three times. Run this syndicate when user queries require rigorous fact-checking, iterative refinement, and verified output quality.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/critic.yaml" -->
Run: `npm run syndicate:critic`

- memory: `session-only`
- orchestrator: **ReviewOrchestrator** (`gemini-3.6-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| DrafterAgent | `gemini-3.6-flash` | — | — |
| CriticAgent | `gemini-3.6-flash` | — | — |
<!-- /wiki:generated -->
