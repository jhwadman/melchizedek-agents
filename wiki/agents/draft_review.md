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
Draft Review is the template for outbound writing that must follow rules: a customer reply, a release announcement, a policy notice, a product description. A Drafter writes from the brief, a Reviewer checks the draft against the `policy` variable rule by rule, and the Editor runs the loop. The Editor never writes, edits or reviews text itself.

The loop is bounded. The Reviewer's reply begins with a fixed token, APPROVED or REVISE, so the stop condition is read from text. Each Reviewer call opens with "Round n of N", so the Editor reads the count from the transcript. The cap is `max_rounds` (2 as shipped) in the Editor's prompt, and `max_steps: 14` enforces it in code. When the cap is reached without approval, the reply starts "NOT APPROVED: open issues below" and lists the Reviewer's open items. A brief that lacks a fact gets a `[NEEDS: …]` placeholder from the Drafter. The Reviewer fails any draft that holds one, and the Editor stops early, because a revision cannot supply the fact.

Memory is `internal-only`: each piece of writing is one sitting. Copy it, put your style guide, legal lines and banned claims in `policy` as checkable rules, and consider a different provider for the Reviewer so the two agents do not share blind spots. [Critic Review](/agents/critic.md) teaches the same loop with a numeric confidence score instead of a checklist.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/draft_review.yaml" -->
- memory: `internal-only` · max_steps: 14
- orchestrator: **Editor** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Drafter | `gemini-3.8-flash` | — | — |
| Reviewer | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
