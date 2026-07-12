# Melchizedek — Semantic Long-Term Memory Architecture

How `SupabaseVectorMemoryService` implements the long-term memory pipeline,
and — critically for anyone deploying an agent to real users — how memory is
**siloed per user** and **erased on request**.

> Historical note: earlier versions of this pipeline ran on Firestore /
> Vertex AI Vector Search. The implementation is now **Supabase Postgres +
> pgvector** end-to-end (see `supabaseMemoryService.ts`); session state
> lives in the same database (`adk_sessions`).

## 1. The goal

Raw conversation histories grow linearly; token counts explode and early
context falls out of the attention window. Melchizedek instead compresses
past conversations into discrete **structured memory records**, embeds
them as vectors, and retrieves the most relevant records when a new query
arrives — RAG over the agent's own experience, with enough structure that
the record can be **evolved** (corrected, superseded, contradicted) rather
than only appended to.

## 2. The record format

Each stored record is one structured line — the whole line is embedded, so
its dates, units, and sources all participate in semantic recall:

```
[TAG | date: YYYY-MM-DD | source: <who asserted it> | status: active|historical | keys: k1, k2] record text
```

- **TAG** — `[FACT]`, `[PREFERENCE]`, `[DECISION]`, `[ACTION]`,
  `[CONTEXT]`, `[INSIGHT]`, `[CORRECTION]`, or `[EPISODE]` (one narrative
  session summary per ingestion — the semantic thread between discrete
  records).
- **date** — the date the record is *about*, converted from relative to
  absolute at write time ("last Tuesday" is stored as its YYYY-MM-DD).
- **source** — who asserted it: the user, a named clinician/counterparty,
  a document, a report. The model's own general knowledge is never stored.
- **status** — `active` or `historical`; a third value, `superseded`, is
  applied by the store itself when a later correction retires the row.
- **keys** — 1–5 lowercase entity index terms (names, medications,
  metrics, topics) connecting the record to future queries.
- **supersedes** (corrections only) — a short quote of the outdated claim,
  used to find and retire the old row.
- **Values keep their units** exactly as stated ("25 mg twice daily",
  "1.4 mg/dL") — never rounded or restated from model knowledge.
- **Unresolved contradictions are kept, not resolved**: both records are
  stored plus a `[CONTEXT]` record naming the conflict (key:
  `contradiction`). Silently picking a side would falsify the record.

The header fields are also parsed into dedicated columns (`tag`,
`fact_date`, `source`, `status`, `keys`, `superseded_by`) so recall can use
more than similarity (see Phase 2). Schema: base tables in the root README;
upgrades via [`db/memory_v2.sql`](../../db/memory_v2.sql).

## 3. The core pipeline

### Phase 1: Ingestion (`addSessionToMemory`)

Triggered on CLI `exit`/`SIGINT`, after CLI one-shot invocations, and (on
the A2A server) after every completed task:

1. **Serialization** — session events (user prompts, orchestrator
   responses) are flattened into a text transcript.
2. **Record extraction** — the transcript goes to the extraction model
   with `FACT_EXTRACTION_PROMPT`, which distills structured records in the
   format above (discarding filler, converting dates, preserving units,
   attributing sources). Malformed lines are dropped, never stored.
3. **Embedding** — each record line is embedded individually by
   `gemini-embedding-001` at **768 dimensions** (embedding whole
   transcripts produces "muddy" averaged vectors; single records produce
   sharp semantic clusters).
4. **Storage** — record + vector + parsed columns are inserted into
   `adk_memory_facts`, tagged with the **`user_key`** (see §4). Inserts
   are **deduplicated** against records already stored for that key, so
   re-ingesting the same conversation (which stateless A2A callers do
   every turn) never duplicates rows.
5. **Supersession** — each `[CORRECTION]` record then retires the rows it
   corrects: the `supersedes` quote is embedded and similarity-searched
   against the user's active rows; candidates that are semantically close
   *and* share an index key (or are near-exact matches) are marked
   `status='superseded'` and linked via `superseded_by`. Retired rows are
   kept, not deleted — the record's history stays inspectable.

### Phase 2: Retrieval (`searchMemory`)

Recall is **hybrid** — three channels connect a query to the history:

1. **Similarity** — the query is embedded and the `match_memory_facts`
   RPC runs a cosine KNN search **filtered by `user_key` inside the
   database**, returning a candidate pool (top 24) with the structured
   columns.
2. **Index keys** — candidates whose `keys` appear in the query text are
   boosted (the "metoprolol" question finds the metoprolol records even
   when phrasing diverges).
3. **Dates** — candidates whose `fact_date` matches a month/year named in
   the query are boosted ("the March labs" finds `2026-03` records).

Active records get a rank boost over retired ones; superseded records that
still surface are **relabeled** (`status: SUPERSEDED by a later
correction`) so an outdated claim can never masquerade as current state.
The top 10 re-ranked records are injected into the orchestrator's context
via the ADK `preload_memory` (automatic) or `load_memory` (explicit tool
call) mechanisms.

## 4. Multi-user siloing (read this before deploying to real users)

Every fact and every session row is keyed by:

```
user_key = {appName}/{userId}
```

Retrieval is filtered by `user_key` in Postgres, so facts can never cross
keys. **The entire silo therefore depends on `userId` being distinct per
human.** Where `userId` comes from, by entry point:

| Entry point | userId | Silo granularity |
|---|---|---|
| CLI (`syndicate_chat.ts`) | `MELCHIZEDEK_USER_ID` env var, default `local-user` | one bucket per env value — everyone at the terminal shares unless you set it |
| A2A server, no header | `a2a-{sha256(apiKey)[:16]}` | one bucket per API key — all end users behind one backend key SHARE memory |
| A2A server + `X-User-Id` | `a2a-{keyhash}/{X-User-Id}` | **one bucket per end user** — this is the mode for sites/apps |

### Deploying an agent (e.g. the Patient Advocate) behind a website

The site authenticates its own users, then passes each user's id on every
A2A request:

```bash
curl -X POST https://your-server/patient_advocate/a2a/jsonrpc \
  -H "Authorization: Bearer $A2A_SERVER_SECRET" \
  -H "X-API-Key: $BACKEND_GEMINI_KEY" \
  -H "X-Provider: google" \
  -H "X-User-Id: user-8f3a2c" \
  -H "Content-Type: application/json" \
  -d '{ "jsonrpc": "2.0", "id": 1, "method": "message/send", ... }'
```

Rules of the header:

- Format: `[A-Za-z0-9._-]{1,64}` — anything else is rejected with 400.
  Use your app's opaque account id, never an email or name (the id appears
  in keys and logs).
- The id is **namespaced beneath the caller's API-key hash**
  (`a2a-{keyhash}/{id}`), so two different callers using the same id can
  never touch each other's silos — a caller can only reach silos it could
  have written.
- **The server trusts the header within the caller's silo.** Authenticate
  your users BEFORE putting their id in it; a site that lets visitors
  choose arbitrary ids has defeated its own siloing.
- Sessions inherit the same `userId`, so conversation resumption is siloed
  identically.

### Erasure (right to be forgotten)

```bash
curl -X DELETE https://your-server/memory \
  -H "Authorization: Bearer $A2A_SERVER_SECRET" \
  -H "X-API-Key: $BACKEND_GEMINI_KEY" \
  -H "X-User-Id: user-8f3a2c"
# → { "deleted": 12 }
```

Deletes every fact in the calling silo (key hash + `X-User-Id`). Omitting
the header erases the key-level bucket instead. Programmatic equivalent:
`SupabaseVectorMemoryService.deleteUserMemory(userKey)`.

**Scope caveat:** this clears `adk_memory_facts` only. Session transcripts
in `adk_sessions` are a separate store; full erasure of a user requires
clearing their rows there as well (`npm run db:purge` wipes ALL sessions —
dev only).

### Hardening

Run [`db/hardening.sql`](../../db/hardening.sql) in the Supabase SQL
Editor **before serving real user data**. The A2A server verifies this at
boot: it logs `✓ DB hardening verified` when applied, warns loudly when
not, and **refuses to start a public deployment** (`PUBLIC_URL` set)
without it unless you explicitly opt out with `ALLOW_UNHARDENED_DB=true`.

Understand what each tier buys — this is the part most setups get wrong:

- **Unhardened (default Supabase):** tables in the `public` schema are
  exposed through the auto-generated REST API. With RLS disabled, the
  widely-shared `anon` key can read every transcript and memory fact.
  This is the hole tier 1 closes.
- **Tier 1 (`db/hardening.sql`):** enables RLS with no policies for
  `anon`/`authenticated` (deny-by-default) and revokes their table and
  RPC privileges. The public API paths are now dead ends. **Honest
  limitation:** the Melchizedek server connects with the `service_role`
  key, which *bypasses RLS by design* — tier 1 constrains everyone except
  the server itself. Application-level `user_key` scoping remains the
  server's silo.
- **Tier 2 (commented template at the bottom of `db/hardening.sql`):** a
  dedicated `melchizedek_app` Postgres role bound by RLS policies scoped
  to `current_setting('app.user_key')`, set per transaction. This
  constrains the server too — buggy application code physically cannot
  read across silos. It requires connecting via a direct Postgres role
  rather than the service-role REST client, so it's a deliberate
  architecture step, not a paste-and-done.
- **Beyond:** when tenants are organizations rather than individuals,
  prefer a database (or Supabase project) per tenant.

Never ship the `service_role` key to a browser or mobile client under any
tier. It belongs to the server environment only.

## 5. Gotchas

- **Embedding dimensionality is a hard coupling.** `embedding vector(768)`
  in the table schema must match `EMBEDDING_DIMENSIONS` in `lib/config.ts`.
  Changing the embedding model means dropping and recreating the table and
  index.
- **Structured columns require the v2 schema.** Inserts write `tag`,
  `fact_date`, `source`, `status`, `keys` — a database still on the v1
  table shape will reject them. Run `db/memory_v2.sql` (or the v2 create
  block in the README) before upgrading the code.
- **Extraction is lossy and costs one model call per ingestion.** What the
  extractor discards is gone; what it stores wrong persists wrong. On the
  A2A server, ingestion runs after the reply is delivered so it never adds
  user-visible latency.
- **Memory bills the operator.** Extraction and embeddings use the server's
  `GOOGLE_GENAI_API_KEY`, not the caller's BYOK key — memory is
  infrastructure, like tools.
