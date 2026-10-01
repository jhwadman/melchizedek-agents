---
type: syndicate
title: Case Desk
description: The Case Desk syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/case_desk.yaml
---

# Case Desk

<!-- wiki:fill slot="charter" -->
Case Desk is the session-memory template. It works one operational case across a conversation that may run for hours: an incident, an escalated customer problem, a vendor outage, a stuck onboarding. Every reply says what the new information means, lists one to three next actions, and ends with a CASE STATE block in a fixed shape: summary, severity, status, known, tried, hypotheses, next. Because the block ends every reply, the latest state is always in the most recent turn.

CaseLead converses and keeps the state. Runbooks searches the team's procedures with `wiki_search`, `wiki_read` and `wiki_links` over the markdown bundle at `WIKI_ROOT` (`./wiki` when unset). Reader opens a pasted status page, vendor document or log link with `web_extract`. The Lead calls each at most once per turn. When no runbook matches, the Lead says so and labels any step of its own "Suggestion, not from a runbook:". It records a case as resolved only when the person says so, and changes severity only with a reason from the thread. Severities come from the `severity_scale` variable, SEV1 to SEV4 as shipped.

Memory is `session-only`: the thread persists in the session store, so the same A2A `contextId` or CLI session resumes the case. Nothing is distilled into long-term memory. Use it for work that spans many turns and then ends; for facts that must outlive the case, use [Account Memory](/agents/account_memory.md).
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/case_desk.yaml" -->
- memory: `session-only` · max_steps: 16
- orchestrator: **CaseLead** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Runbooks | `gemini-3.1-flash-lite` | `wiki_search`, `wiki_read`, `wiki_links` | — |
| Reader | `gemini-3.1-flash-lite` | `web_extract` | — |
<!-- /wiki:generated -->
