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

Long-term memory is `SupabaseVectorMemoryService` — the ADK `BaseMemoryService` contract backed by one Postgres table (`adk_memory_facts`, defined in the [canonical schema](/memory/schema.md)) with pgvector embeddings (768 dims by default).

## What computes it

Extraction and embeddings are configured per deployment ([ADR 0020](/decisions/0020-memory-contract.md)), in `lib/memory/providers.ts`:

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_EXTRACTION_MODEL` | `gemini-3.8-flash` | Any model id. It runs through the same adapter an agent with that id would, so every provider and the gateway work, and each call is an `llm.request` span in the ledger. |
| `MEMORY_EMBEDDING_PROVIDER` | `gemini` | `gemini`, `openai`, `ollama`, or `openai-compatible` (any `POST /embeddings` endpoint: Azure, LiteLLM, an internal proxy). |
| `MEMORY_EMBEDDING_MODEL` | `gemini-embedding-001` / `text-embedding-3-small` / `nomic-embed-text` | Per provider. |
| `MEMORY_EMBEDDING_DIMENSIONS` | `768` | Must equal the vector column it was created with; a returned vector of another length is refused. |
| `MEMORY_EMBEDDING_BASE_URL`, `MEMORY_EMBEDDING_API_KEY` | — | For `openai-compatible` (and to override the OpenAI or Ollama endpoint). |

The ledger's semantic search (`npm run telemetry:embed`) uses the same embedder, so both vector columns stay comparable. A deployment that sets nothing behaves as before: Gemini for both, on the server's key.

## Where it is stored

The memory logic runs on a `MemoryStore` (`lib/memory/store.ts`), the five database operations it needs: existing facts, nearest facts, insert, retire, delete. There are two implementations over the same table and the same `match_memory_facts` function:

- **Supabase**, over its REST client.
- **Direct Postgres** (`lib/storage/postgres`, [ADR 0021](/decisions/0021-postgres-first-storage.md)), on any Postgres with pgvector.

`postgresStorage({ connectionString })` also provides sessions, A2A tasks and erase on the same connection:

- **Sessions** are stored one row per event in `adk_session_events`, so two turns on one conversation both land.
- **A2A tasks** in `adk_a2a_tasks` are scoped to their owner and shared by every instance.
- **`erase(scopeKey)`** removes a scope's facts, conversations (sub-agent rows included), ledger rows and tasks in one transaction (`melchizedek_erase_scope`).

The suite `tests/postgresStorage.test.ts` runs all of it against a real Postgres when `TEST_DATABASE_URL` is set.

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
