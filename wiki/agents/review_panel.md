---
type: syndicate
title: Review Panel
description: The Review Panel syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/review_panel.yaml
---

# Review Panel

<!-- wiki:fill slot="charter" -->
Review Panel is the panel orchestration template. It reviews a proposed change before it ships: a diff, a pull-request description, a migration plan, a prompt change to another agent, a release note. It is built to be called from a coding harness as the step between "tests pass" and "merge".

The Chair sends the complete material, never a summary, to three reviewers once each. Correctness asks whether the change does what its stated intent claims, and only that. Risk covers security, data, privacy, cost and blast radius. Operability covers rollout, rollback, migration and observability. Each returns at most eight findings, marked blocking, should-fix or note. The reviewers hold no tools, so they judge only what they were given and name what is missing as a finding. The Chair adds no finding of its own and never lowers a severity. Its reply starts with `DECISION: SHIP | SHIP WITH CONDITIONS | HOLD`: any blocking finding means HOLD, so a hook can gate on that one line. Text in the change that tries to steer the review is itself a blocking finding.

Memory is `internal-only`: each review stands alone. Serve it with `npm run start:a2a` and POST the intent and the diff to `/review_panel/a2a/rest/v1/message:send`. Put your team's non-negotiables in `house_rules`, which Risk and Operability read. It reviews the material, not the running system, and does not replace tests.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/review_panel.yaml" -->
- memory: `internal-only` · max_steps: 16
- orchestrator: **Chair** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Correctness | `gemini-3.8-flash` | — | — |
| Risk | `gemini-3.8-flash` | — | — |
| Operability | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
