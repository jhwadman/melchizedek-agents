---
type: protocol
title: A2A
description: Any syndicate served over A2A 1.0 (with 0.3 compatibility) and any A2A agent callable as a subagent — the plug points for identity and keys, which agents are served, limits, and the compile-time-bindings trap.
tags:
  - a2a
  - protocols
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: scripts/a2a_server.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/remoteAgent.ts
  - resource: lib/a2a/identity.ts
  - resource: lib/a2a/executor.ts
  - resource: lib/a2a/policy.ts
---

# A2A

`npm run start:a2a -- <syndicate>.yaml` (package: `npx melchizedek-serve`) serves a [syndicate](/agents/) over A2A on `$PORT` (default 4000). The server is `createA2AApp(options)` in `lib/a2a/app.ts`, mountable in any Express app; the bin (`scripts/a2a_server.ts`) reads the environment, listens and drains on SIGTERM. Every task runs through the one turn runtime, `runSyndicateTurn` ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)).

## Protocol

The server speaks A2A 1.0 with the SDK's 0.3 compatibility on every handler: the agent card lists both versions' endpoints, a request with no `A2A-Version` header is treated as 0.3, and 0.3 method names, part shapes and state spellings are translated both ways. Routes: `/.well-known/agent-card.json`, `/a2a/jsonrpc`, `/a2a/rest` for the boot syndicate, and the same under `/<agentId>/` for others — each card advertises its own URLs and declares its security schemes. `/healthz` and `/readyz` answer without credentials.

A syndicate can also CALL an A2A agent: a subagent with `a2a_agent_url:` is a remote agent (1.0 or 0.3, the card decides), reached as a delegation tool or a plan-dispatch route through `lib/a2a/remoteAgent.ts`. Its card and endpoints pass the SSRF guard; credentials come from `A2A_AGENT_TOKENS` (host → bearer or headers).

## Identity and keys

Two separate questions, each a plug point ([ADR 0017](/decisions/0017-plug-points.md)): who the caller is, which decides whose data a request touches, and who pays for the models. `A2A_AUTH` answers the first ([ADR 0025](/decisions/0025-built-in-authenticators.md)); the built-in authenticators live in `lib/a2a/identity.ts` and are what `createA2AApp`'s `resolveRequest` takes.

- `A2A_AUTH=secret` (default) — every caller presents the one `A2A_SERVER_SECRET`; the calling backend names its end user in `X-User-Id`. Without a secret the server binds loopback only; with `PUBLIC_URL` set it refuses to start without one, or with the `.env.example` placeholder.
- `A2A_AUTH=callers` — one bearer token per calling backend, listed in `A2A_CALLERS` as `name:sha256[:scope]`. The config holds only each token's hash. A caller owns its scope, and an `X-User-Id` it sends nests beneath it. A scope is stable across model-key rotation, and callers given the same scope share data, which is how a deployment keeps its existing key-hash silo. `A2A_SERVER_SECRET`, while still set, keeps working beside the tokens with its old scoping, so callers move over one at a time. `melchizedek-serve --new-caller <name> [--scope s] [--token-file f]` mints a token.
- `A2A_AUTH=jwt` — a JWT from the deployment's identity provider (`A2A_JWT_JWKS_URL`, or an HS256 `A2A_JWT_SECRET`), with issuer, audience and expiry required. The scope is the user claim (`sub`), under the tenant claim when `A2A_JWT_TENANT_CLAIM` is set. A claim value that is not key-safe is stored as `h-` plus a SHA-256 prefix.
- `A2A_AUTH=header` — an authenticating gateway in front sets `A2A_TRUSTED_USER_HEADER`. It requires `A2A_SERVER_SECRET`, which only the gateway holds, so no other client can set the header.

Billing is `A2A_KEY_MODE`, whatever the authenticator:

- `server` (default) — the server's own provider keys pay.
- `byok` — the caller's `X-API-Key` pays, and a task request without one is refused (unless the authenticator supplies a key itself). `X-Provider` (default `google`) names the provider that key belongs to; the key reaches only agents whose model is on that provider. Agents on any other provider, tools that call a model, and memory extraction and embeddings run on the server's own environment keys. Under the shared secret only (`A2A_AUTH=secret`, or `A2A_SERVER_SECRET` still accepted beside caller tokens), the key's hash also prefixes the stored scope (`a2a-<hash>[/<user>]`).

In `server` mode `X-API-Key` and `X-Provider` are ignored.

The agent card declares the schemes the configured authenticator enforces.

Data is stored under the syndicate's `memory_namespace` when it declares one, else `melchizedek-a2a` ([ADR 0020](/decisions/0020-memory-contract.md)). `DELETE /memory` erases everything held for the calling scope in the default syndicate's namespace (`?all=1`: every namespace), in one transaction (`melchizedek_erase_scope`, migration 0002): memory facts, sessions with their subagent rows, the ledger's turns, spans, payloads, verdicts and labels for those conversations, and the scope's stored A2A tasks. It answers with a count per store, and 501 when the server has no durable storage. A caller-token or key-hash scope that sends no `X-User-Id` also erases its end users' scopes beneath it. The budget counters hold only a hash of the scope and are not erased.

## Which agents are served

A bare `/<agentId>/` is `<agentId>.yaml` in the deployment's agents directory. The shipped `examples/` and `templates/` answer only ids in `A2A_SERVED_AGENTS`, and that list, when set, is the whole served set. The registry answers `registry:<id>`, and bare ids in `A2A_REGISTRY_AGENTS`; a registry miss is a 404 and a registry failure a 503, never a fallback to a file ([ADR 0018](/decisions/0018-files-are-the-source-of-truth.md)). Every load logs its source. A loaded config is cached for the life of the process, so a change needs a restart.

## Limits and lifecycle

Each task has a deadline (`A2A_TASK_TIMEOUT_MS`, default 15 minutes) and a turn-wide model-call cap (the YAML's `max_steps`); `tasks/cancel` aborts the provider call in flight. The task rate limit counts submissions only, not polling GETs (`A2A_RATE_LIMIT_MAX`, default 60, per `A2A_RATE_LIMIT_WINDOW_MS`, default 15 minutes): per caller or per end-user scope when an authenticator is configured, per IP under the shared secret. The failed-login limit (`A2A_AUTH_FAILURE_MAX`, default 30 per 15 minutes per IP), the concurrency cap (`A2A_MAX_CONCURRENT_TASKS`, default unlimited), trust-proxy (`A2A_TRUST_PROXY`, default 1 hop) and body limit (`A2A_BODY_LIMIT`, default `1mb`) are environment settings too.

The server is not stateless. The config cache, the rate-limiter counters, the concurrency count and the memory-ingestion high-water mark are always per process. A2A tasks are per process too unless `DATABASE_URL` plugs in the Postgres storage, whose task store (`adk_a2a_tasks`) every instance shares; with Supabase alone, sessions and memory are durable but tasks are not, so run one replica or route a conversation's requests to one instance. The server prints no conversation content unless `OTEL_CONSOLE_SPANS=true`.

Governance ([ADR 0026](/decisions/0026-governance-policy-and-visibility.md)) runs on the `policy` plug point:

- **Budgets.** `A2A_BUDGETS` sets daily limits per UTC day, per caller and per scope, on tasks, model calls and tokens; for example `{"perCaller":{"tokens":5000000},"callers":{"reports":{"tasks":100}},"perScope":{"tasks":50}}`. A task over budget ends `rejected` with the reason before it takes a slot. A store that cannot be read refuses. The counts live in `melchizedek_usage` (migration 0004, scopes stored only as a hash) when Postgres or Supabase is configured, else in process memory.
- **One record per task**, however it ended: agent, caller, a hash of the scope, status, reason, duration, model calls and tokens. `A2A_LOG_FORMAT=json` prints it as a JSON line among the server's other JSON lines.
- **Metrics.** `GET /metrics` (Prometheus text) serves tasks, model calls, tokens by kind, a task-duration histogram and tasks in flight, behind its own `A2A_METRICS_TOKEN`. Labels are agent, outcome and caller name, never a scope.

## The bindings trap

`{{token}}` bindings evaluate **once per agent load** — at boot for the boot syndicate, at first request for `/<agentId>/` ones. Long-lived deployments must therefore never pass per-request data through bindings: prepend it to the message instead, for example a `[System Context: Current Date is …]` line the prompt treats as authoritative over the frozen `{{current_date}}` (the shipped `research.yaml` does this; memory extraction strips such lines). Message parts may be text or `data` (sent to the model as JSON). A message with a file part ends `rejected`, as does one with no text.

Auth failures and their fixes are catalogued in [failure modes](/operations/failure-modes.md).
