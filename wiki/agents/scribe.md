---
type: syndicate
title: The Scribe
description: Writes one reader-facing document from a brief, audits it through the Auditor, and returns the document alone.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-24
sources:
  - resource: config/agents/examples/scribe.yaml
---

# The Scribe

<!-- wiki:fill slot="charter" -->
Most reader-facing text around a codebase is written from facts that already exist somewhere else: a README from the manifest, a skill file from the commands it teaches, a page of copy from a list of what the product does. The Scribe is the starter-pack agent for that job. The user pastes a **brief** (audience, kind of document, purpose, the facts it may state, the identifiers that must appear verbatim, its limits) and gets back the document and nothing else.

Two roles: the **Scribe** (orchestrator) writes the draft under a fixed voice standard (every fact from the brief, an actor in every sentence, no rhetorical contrast, no slogans, no promotional vocabulary), sends brief and draft to the **Auditor**, repairs every violation, and re-audits at most twice. The Auditor is a leaf with no tools and a JSON output schema: `ok` plus a list of violations, each with the rule, the offending quote and a fix. The JSON contract sits on the leaf because an agent cannot hold both an `outputSchema` and AgentTools (the same constraint as [Critic Review](/agents/critic.md)).

Run it one shot with `CHAT_STREAMING=false npm run syndicate:scribe -- "$(cat brief.md)"`; the document is everything after the last `Scribe › ` line. The framework's own public [agent-skills suite](/operations/agent-skills.md) was written this way, one brief per skill, with a person reviewing each result. The production sibling is melch.ai's copy pipeline, where a runner script performs the audit in code; this file keeps the loop inside the syndicate so it runs anywhere with one Gemini key.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/scribe.yaml" -->
Run: `npm run syndicate:scribe`

- memory: `internal-only`
- orchestrator: **Scribe** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Auditor | `gemini-3.8-flash` | — | — |
<!-- /wiki:generated -->
