---
type: subsystem
title: Memory architecture
description: Session transcripts distilled into typed, supersedable facts with hybrid vector recall — multi-user siloed, GDPR-erasable, resilient to malformed extractions.
tags:
  - memory
  - supabase
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/memory/README.md
---

# Memory architecture

Long-term memory is `SupabaseVectorMemoryService` — the ADK `BaseMemoryService` contract backed by one Postgres table (`adk_memory_facts`, defined in the [canonical schema](/memory/schema.md)) with pgvector embeddings (`gemini-embedding-001`, 768 dims).

## Write path

`addSessionToMemory` serializes the session's events, then a low-temperature extraction model distills them into one-line records:

```
[TAG | date: | source: | status: | keys: ] fact text
```

Eight tags (`FACT`, `PREFERENCE`, `DECISION`, `ACTION`, `CONTEXT`, `INSIGHT`, `CORRECTION`, `EPISODE`); notable extraction rules: units never rounded, relative dates converted to absolute, the model's own training knowledge never stored, unresolved contradictions store **both** sides, exactly one `EPISODE` narrative per transcript. Malformed lines are dropped — a bad extraction must never poison the store. Exact-duplicate facts are deduped per user key, because stateless A2A callers re-ingest the whole session every turn.

## Supersession

A `CORRECTION` record carries a quote of what it supersedes. The service embeds that quote, vector-searches the user's rows, and soft-retires a match at cosine ≥ 0.85 — or ≥ 0.6 when the two records share an index key. Retired rows keep `status='superseded'` and a pointer to their corrector, so history stays inspectable, and recall rewrites their header to say so — a retired fact can never masquerade as current state.

## Recall

`searchMemory` is hybrid: pgvector cosine (top 24 via the `match_memory_facts` RPC), then in-process re-ranking — boosts for index-key hits (+0.12), year (+0.08) and month (+0.10) matches parsed from the query, and active status (+0.05) — sliced to 10. Agents reach it by declaring `load_memory` / `preload_memory` in YAML with `memory_system: "long-term"`.

## Boundaries

Every row is siloed by `user_key = appName/userId`. `deleteUserMemory` hard-deletes a user's facts and **throws** on failure rather than silently no-op'ing — session transcripts in `adk_sessions` need separate clearing. How the whole framework fits around this: [architecture](/overview/architecture.md).
