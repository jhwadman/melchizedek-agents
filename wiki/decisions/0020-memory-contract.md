---
type: decision
title: 'ADR 0020: Memory is keyed by a stored namespace and a supplied scope key, computed by a configured provider, saved at least once, and erased in one operation'
description: A long-term syndicate declares a memory_namespace (its name plus a generated identifier, written once and never recomputed); facts are filed under namespace and scope key; extraction and embeddings run on a configured provider; the ingestion marker is durable; and one erase covers every store that holds the user's words.
tags:
  - decision
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/memory/supabaseMemoryService.ts
  - resource: lib/session/supabaseSessionService.ts
  - resource: lib/a2a/app.ts
---

# ADR 0020: Memory is keyed by a stored namespace and a supplied scope key, computed by a configured provider, saved at least once, and erased in one operation

## Context

The memory record model is sound: dated, source-attributed facts, corrections that retire stale facts while keeping their history, and duplicate detection. Four questions behind it were answered by accident.

- **Whose memory.** On the server every syndicate shared one silo per caller (`melchizedek-a2a/<key hash>`), though the documentation said memory is per syndicate. On the CLI the key was the syndicate name. Neither survives a key rotation or a rename.
- **What computes it.** Extraction and embeddings were hard-wired to Gemini on the server's own key and were not traced. A deployment approved for one non-Google provider still sent transcripts to Google.
- **Failure.** A failed extraction, embedding or insert still advanced the "already processed" marker, which lived in process memory. Those turns were never distilled.
- **Ending.** Erasure removed facts but not transcripts, sub-agent transcripts or ledger rows. The documented seven-day session expiry was written to every row and enforced nowhere.

## Decision

1. **The key is `<memory_namespace>/<scopeKey>`.**
   - The scope key is supplied per request ([ADR 0017](/decisions/0017-plug-points.md)).
   - `memory_namespace` is a YAML field holding the syndicate name plus a short generated identifier, for example `support_triage.k3f9q2a8`.
   - `npm run doctor -- --fix-namespaces <file>` writes it once, into the files named and no others. It is stored, never recomputed, so renaming a syndicate does not move its memory.
   - A copy of a shipped example or template gets its own identifier the same way, so two teams' copies of one template cannot collide in a shared database.
2. **Sharing is deliberate.** Two syndicates share memory only by declaring the same namespace. The doctor flags a deployment's long-term syndicate with no namespace, and any namespace held by more than one of its syndicates, and prints the fix command.
   - **Enforcement is staged.** Undeclared namespaces fall back to the server-wide `melchizedek-a2a`, where existing deployments' facts already live. A missing namespace becomes a validation error only after live deployments are re-keyed, because declaring one moves new facts to a key that the old ones are not under.
3. **Memory always resolves to the root syndicate's namespace,** whatever ADK app name a nested agent runs under (`namespacedMemoryService`, `lib/memory/namespace.ts`). Memory tools on a sub-agent then read the facts the root wrote.
4. **Extraction runs on any model id** through the model registry, set by the deployment and overridable per syndicate. **Embeddings sit behind an embedder interface** whose model and dimension are deployment configuration. Gemini stays the default. Both calls are traced and attributed to the turn that caused them.
5. **The vector dimension is checked at boot** against the stored column. Changing the embedding model is a re-embed job, not dropping the table.
6. **Ingestion is at-least-once.**
   - The processed marker is a column in storage and advances only after facts are saved.
   - Extraction distinguishes "no facts" from "failed".
   - Duplicate detection makes a retried turn safe.
   - Insert and supersession commit in one transaction.
7. **`eraseScope(scopeKey[, namespace])` removes everything that holds the user's words** (`lib/memory/erase.ts`, over the `melchizedek_erase_scope` SQL function, one transaction):
   - facts;
   - sessions, including sub-agent session rows;
   - ledger turns, spans and payloads.

   It returns per-store counts. Session expiry is enforced by a scheduled prune, and facts may carry an optional retention window per namespace.

> **Note (2026-10-01):** Built: namespaces and `--fix-namespaces`, the root-namespace wrapper, configurable extraction and embeddings (`MEMORY_EXTRACTION_MODEL`, `MEMORY_EMBEDDING_*`), save-before-advance ingestion, `eraseScope`, and the session prune (`melchizedek_prune_sessions()`, nightly under pg_cron or `npm run sessions:prune`). Not yet: the processed marker still lives in process memory, insert and supersession are separate statements, the embedding dimension is checked per vector rather than against the stored column at boot, extraction is not overridable per syndicate, and facts have no per-namespace retention window, see [ADR 0021](/decisions/0021-postgres-first-storage.md).

## Alternatives considered

- **The syndicate name alone as the namespace.** Rejected: a rename orphans memory, and two different syndicates with the same name in one database collide.
- **A namespace derived from the file path or a hash of the config.** Rejected: it moves when the file moves or the prompt changes.
- **Leave memory Google-only and document it.** Rejected: it contradicts bring-your-own-everything ([ADR 0017](/decisions/0017-plug-points.md)) and blocks deployments approved for a single provider.

## Consequences

- Existing rows keyed `melchizedek-a2a/<user>` are re-keyed once to `<namespace>/<scopeKey>` by a migration script, per syndicate.

> **Note (2026-10-01):** No re-keying script ships; an existing silo is kept reachable by mapping callers onto its scope instead of moving data, see [ADR 0025](/decisions/0025-built-in-authenticators.md).
- `memory_namespace` and the extraction model join the syndicate schema.
- Sessions stay keyed by syndicate name, scope key and context id. They are short-lived and expire, so a rename costing a session's continuity is acceptable where it would not be for memory.
- Any memory service implementing the interface can replace the built-in one, for example a managed memory product.
