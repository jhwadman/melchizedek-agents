---
type: syndicate
title: Intake Extractor
description: The Intake Extractor syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/intake_extractor.yaml
---

# Intake Extractor

<!-- wiki:fill slot="charter" -->
Intake Extractor is the short-term memory template, where forgetting is the feature. It turns one inbound document (an email, a web-form submission, a call transcript, a purchase request) into one JSON record your systems can file: the kind of request, a one-sentence summary, the requester, the requested action, references, dates, amounts, deadline, urgency, sentiment, what is missing, and which kinds of sensitive data were redacted.

It is a single agent with an `outputSchema` and `responseMimeType: application/json`, so the reply parses without a second model call. It has no subagents and no tools; the document is the only input. Every field the document may not supply is nullable, and a date that does not name one day ("end of Q3") keeps its words in `date_text` with `date` null. Card numbers, bank details, passwords and government IDs are never copied into the record; `redacted` names the kinds that were present.

Two settings make each request stand alone. `memory_system: internal-only` keeps no session store and no long-term memory in the CLI, and `includeContents: none` means the model sees only the current message. Served over A2A, the server's session store still records the exchange when Supabase is configured; the model never reads it back. Copy it, edit `request_kinds` to your queue's categories, and add schema fields with a line in the instruction for each.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/intake_extractor.yaml" -->
- memory: `internal-only`
- orchestrator: **Intake** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
