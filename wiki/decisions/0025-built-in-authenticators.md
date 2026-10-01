---
type: decision
title: 'ADR 0025: Built-in authenticators — per-caller tokens with a stable scope, JWT, a trusted gateway header; billing stays separate'
description: The server ships four authenticators on the resolveRequest plug point (shared secret, caller tokens, JWT, gateway header). A caller token owns a scope that does not depend on any model key, so key rotation no longer strands memory, and an existing key-hash silo is kept by mapping callers onto it rather than moving data. A2A_KEY_MODE decides only who pays once an authenticator is configured.
tags:
  - decision
  - protocols
  - memory
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/a2a/identity.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
  - resource: tests/identity.test.ts
---

# ADR 0025: Built-in authenticators — per-caller tokens with a stable scope, JWT, a trusted gateway header; billing stays separate

## Context

[ADR 0017](/decisions/0017-plug-points.md) made identity a plug point (`resolveRequest`) but shipped no implementation of it. A deployment therefore had two choices: the one shared `A2A_SERVER_SECRET`, or writing its own resolver.

**The shared secret identifies nobody.** Every calling backend presents the same bearer, so the server cannot tell them apart. It cannot revoke one, limit one, or attribute a turn to one.

**The scope is a hash of a model key.** Under `keyMode: 'byok'`, data is stored under `a2a-<sha256(X-API-Key)>`. Rotating the provider key therefore moves every session and memory out of reach. That happened once in production, stranding 69 records (`plans/memory-silo-survives-key-rotation.md`).

> **Note (2026-10-01):** That plan, and the options A to C it weighed (cited below), are not part of the public repository; this ADR is the public record of them, see [ADR 0022](/decisions/0022-public-source-of-truth.md).

**Plugging in an authenticator turned off byok billing.** `resolveRequest` replaced the whole key mode, so a deployment could not have real identity and caller-funded inference at once.

**What a running deployment looks like.** Every caller of one deployment typically shares one key-hash silo, holding all of its sessions and memory.

## Decision

1. **Four authenticators ship in `lib/a2a/identity.ts`**, selected in the bin by `A2A_AUTH`. Each returns `{ resolveRequest, identityScheme }`, so `createA2AApp({ ...callerTokens(list) })` is the whole wiring, and the agent card declares the scheme it enforces.
   - `secret` (default) — the shared secret, unchanged.
   - `callers` — one bearer token per calling backend. `A2A_CALLERS` lists `name:sha256[:scope]`, so the configuration holds hashes, not tokens. A caller owns its scope, and an `X-User-Id` it sends nests beneath it (`<scope>/<user>`).
   - `jwt` — verified with `jose`: signature, `iss`, `aud` and `exp` are required. The scope is the user claim, optionally under a tenant claim. A claim value that is not key-safe becomes `h-` plus a SHA-256 prefix, never a lossy substitution that could merge two users.
   - `header` — a gateway in front authenticates the user and names them in a header. It is accepted only together with the server secret, which only the gateway holds; the factory refuses the combination without one.
2. **A scope never derives from a model credential** under `callers`, `jwt` or `header`. Rotating a provider key changes who pays and nothing else.
3. **An existing silo is kept by mapping, not by moving data.** A caller entry may name an existing scope (`alpha:<sha256>:a2a-<keyhash>`). Callers given one scope share its data on purpose. Production moves to caller tokens with no data migration.
4. **The shared secret is a migration bridge.** With `A2A_AUTH=callers`, a still-set `A2A_SERVER_SECRET` keeps working with exactly its old scoping (`firstOf(callerTokens, sharedSecret)`). Callers then switch one at a time, and the secret is removed when the last has moved.
5. **Billing is `A2A_KEY_MODE` alone.** Under `byok` the caller's `X-API-Key` pays, whatever the authenticator, unless the identity supplies a key. The key-hash scope applies only under `A2A_AUTH=secret`.

## Alternatives considered

- **`MEMORY_SILO_ID`, one env var replacing the key hash** (option A in the plan). This fixes rotation for a single-owner deployment only: every caller still shares one identity and one scope.
- **Scope on `X-User-Id` alone** (option B). Rejected again: any holder of the shared secret could then read any user's data by naming them.
- **A key-alias table** mapping retired key hashes to a canonical silo (option C). It keeps the key as the identity and adds a lookup to every read. Caller tokens remove the dependency instead of patching it.
- **Re-keying production data to new scopes.** Unnecessary: mapping callers onto the existing scope reaches the same rows, and a write to production memory is the riskier act.
- **A hand-written JWT verifier.** Rejected. `jose` is already in the tree through both protocol SDKs, has no dependencies, and is what this should not be improvised on.

## Consequences

- Production can move to per-caller tokens one caller at a time, with no data migration and no window in which a caller loses its history.
- A leaked caller token is revoked by removing one `A2A_CALLERS` entry, not by rotating a secret every caller shares.
- Per-caller rate limits, budgets and attribution (the governance work) now have an identity to hang on. `RequestIdentity.caller` carries it.
- `jose` becomes a direct dependency of the package.
- Under `jwt`, `X-User-Id` is ignored: the token is the user. A backend that proxies many users with one service token belongs under `callers`.
