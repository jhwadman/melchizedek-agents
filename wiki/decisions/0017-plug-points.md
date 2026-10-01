---
type: decision
title: 'ADR 0017: The engine is a library with plug points; the adopter supplies identity, credentials and storage'
description: Every infrastructure decision the A2A server makes internally becomes an option of the server factory with today's behaviour as the default — who the caller is (a scope key), where model keys come from, where state lives, and what limits apply — and the framework never models users, tenants or organisations itself.
tags:
  - decision
  - protocols
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
  - resource: lib/persistence/supabaseProvider.ts
---

# ADR 0017: The engine is a library with plug points; the adopter supplies identity, credentials and storage

## Context

The A2A server took one argument, a syndicate name, and decided everything else inside itself:

- **Who the caller is:** whoever holds the one shared bearer secret.
- **Whose data a conversation is:** a hash of the caller's model API key (`deriveUserId`).
- **Where state lives:** Supabase when credentials exist, otherwise process memory.
- **Which keys pay for a model:** the caller's header key when `X-Provider` matched the model's provider, otherwise server environment variables.
- **What limits apply:** a hard-coded 60 requests per 15 minutes per IP.

An enterprise adopter already has an identity system, a secret manager, a database and an API gateway. None of them could be plugged in without editing the server.

Two of these were tangled. The same `X-API-Key` decided who pays for the model and whose data a conversation is, so rotating a provider key moved every memory and session out of reach. That happened once in production: 69 records.

The package also exported no way to run a syndicate. The turn logic lived inside the server script, so "embed the engine in your application" stopped at a parsed YAML object.

## Decision

1. **The engine is a library.** One turn runner (`runSyndicateTurn`) and one server factory (`createA2AApp(options)`) are exported. The `melchizedek-serve` bin, the REPL, the worker and the eval bridge are thin hosts over them.
2. **Each infrastructure decision is an option of the factory, and the default reproduces present behaviour.** The plug points:

| Plug point | Answers | Default |
|---|---|---|
| `resolveRequest(req)` → `{ scopeKey, … }` | Who is calling, and whose data this is | Bearer secret authenticates the calling backend; `scopeKey` is `X-User-Id` when sent, else `default` |
| `credentials` | Where each provider's key or endpoint comes from ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)) | Server environment variables |
| `storage` | Sessions, memory, tasks, queue, registry ([ADR 0021](/decisions/0021-postgres-first-storage.md)) | In-memory |
| `memory` | Extractor and embedder ([ADR 0020](/decisions/0020-memory-contract.md)) | Gemini, as today |
| `policy` | Rate limits, budgets, tool approvals | Configurable limiter; no budgets |
| `registerTool`, `registerGuard`, custom routes | Adopter-owned tools, guards and HTTP routes | The built-in registries |

> **Note (2026-10-01):** The factory's `storage` default is Supabase through supabase-js when `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are set, and in-memory otherwise; the `melchizedek-serve` bin plugs in `postgresStorage` when `DATABASE_URL` is set, see [ADR 0021](/decisions/0021-postgres-first-storage.md).

3. **The scope key is opaque and supplied, never derived from a credential.** The framework stores data under it and never interprets it. "User", "tenant" and "organisation" are the adopter's concepts. The identity system that authenticated the request decides the string.
4. **Bring-your-own-key is a mode, not the default.** With `keyMode: 'byok'` the caller's `X-API-Key` funds its declared provider, and the key hash prefixes the scope key so key holders stay isolated from one another. Outside that mode `X-API-Key` is not required, and callers never handle provider keys.

## Alternatives considered

- **A built-in user and tenant model** (accounts, organisations, per-tenant keys in the framework's own tables). Rejected: every enterprise already has one, and a second would have to be synchronised with it.
- **Keep the server monolithic and add environment variables for each choice.** Rejected: a variable can pick between built-in behaviours, but cannot plug in an OIDC verifier, a secret manager or a policy engine.
- **Keep the key-hash identity as the default.** Rejected: it couples billing to data ownership, and routine key rotation then loses data.

## Consequences

- Rotating a model key changes who pays and nothing else.
- Existing data keyed by `a2a-<keyhash>` either stays reachable through `keyMode: 'byok'` or is re-keyed once by a migration script.
- The package's public API grows by the runner, the factory and the registration functions. That is a versioned surface ([ADR 0007](/decisions/0007-engine-as-package.md)), and ADK types stay behind it.
- Agent cards declare the security schemes the configured `resolveRequest` enforces.
- A private deployment registers its own tools, routes and identity hook against the published package rather than living inside the engine ([ADR 0022](/decisions/0022-public-source-of-truth.md)).
