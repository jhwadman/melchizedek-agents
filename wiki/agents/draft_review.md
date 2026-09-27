---
type: syndicate
title: Draft Review
description: The Draft Review syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/draft_review.yaml
---

# Draft Review

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/draft_review.yaml" -->
- memory: `internal-only` · max_steps: 14
- orchestrator: **Editor** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Drafter | `gemini-3.8-flash` | — | — |
| Reviewer | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
