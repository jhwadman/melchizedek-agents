---
type: syndicate
title: Account Memory
description: The Account Memory syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/account_memory.yaml
---

# Account Memory

<!-- wiki:fill slot="charter" -->
Account Memory is the long-term memory template. It serves the person who owns client relationships: an account manager, a consultant, a customer-success lead. It remembers what each client asked for, decided, prefers and was promised, across every conversation, and drafts follow-ups from those records.

The AccountLead orchestrator handles three cases. For NOTES it restates, one fact per line, what it will keep, so the user can correct it at once. For PREP it lists open commitments, recent decisions, preferences and people, each with its provenance ("per your note of …"). For FOLLOW-UP it calls the Writer subagent once with the recipient, the purpose and the dated facts. Writer uses only those facts and writes `[NEEDS: …]` where one is missing. Where two records conflict, the Lead shows both with their dates and asks which stands.

Recall uses `preload_memory`, which injects relevant records before each message, and `load_memory`, at most two calls per turn. After each completed A2A task, or at CLI exit, the transcript is distilled into records under the file's `memory_extraction_rules`. The `never_store` variable resolves into both those rules and the Lead's instruction, so the Lead never promises to keep what the extractor drops. Records are siloed per caller and, beneath that, per `X-User-Id`. Use one `X-User-Id` per account manager, not one per client; `DELETE /memory` erases the calling silo.

It needs `GOOGLE_GENAI_API_KEY`, plus `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for long-term memory. Without Supabase it still runs, with memory disabled and a warning. Copy it when an agent must know someone across months; `memory_extraction_rules` is where the domain lives.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/account_memory.yaml" -->
- memory: `long-term` · max_steps: 12
- orchestrator: **AccountLead** (`gemini-3.8-flash`) · tools: `preload_memory`, `load_memory`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Writer | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
