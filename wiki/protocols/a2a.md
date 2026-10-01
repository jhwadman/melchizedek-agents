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
---

# A2A

`npm run start:a2a -- <syndicate>.yaml` (package: `npx melchizedek-serve`) serves a [syndicate](/agents/) over A2A on `$PORT` (default 4000). The server is `createA2AApp(options)` in `lib/a2a/app.ts`, mountable in any Express app; the bin (`scripts/a2a_server.ts`) reads the environment, listens and drains on SIGTERM. Every task runs through the one turn runtime, `runSyndicateTurn` ([ADR 0024](/decisions/0024-adk-behind-the-runtime-seam.md)).

## Protocol

The server speaks A2A 1.0 with the SDK's 0.3 compatibility on every handler: the agent card lists both versions' endpoints, a request with no `A2A-Version` header is treated as 0.3, and 0.3 method names, part shapes and state spellings are translated both ways. Routes: `/.well-known/agent-card.json`, `/a2a/jsonrpc`, `/a2a/rest` for the boot syndicate, and the same under `/<agentId>/` for others — each card advertises its own URLs and declares its security schemes. `/healthz` and `/readyz` answer without credentials.

A syndicate can also CALL an A2A agent: a subagent with `a2a_agent_url:` is a remote agent (1.0 or 0.3, the card decides), reached as a delegation tool or a plan-dispatch route through `lib/a2a/remoteAgent.ts`. Its card and endpoints pass the SSRF guard; credentials come from `A2A_AGENT_TOKENS` (host → bearer or headers).

## Identity and keys

Plug points ([ADR 0017](/decisions/0017-plug-points.md)) decide who the caller is and who pays:

- `A2A_SERVER_SECRET` — the bearer every request presents. Without it the server binds loopback only; with `PUBLIC_URL` set it refuses to start without one, or with the `.env.example` placeholder.
- `A2A_KEY_MODE=server` (default) — the server's own provider keys pay; sessions and memory are stored under `X-User-Id`, else `default`.
- `A2A_KEY_MODE=byok` — the caller's `X-API-Key` funds agents on the provider named by `X-Provider`; its hash prefixes the stored scope, with `X-User-Id` beneath it. Data written before the plug points exists only under these key-hash scopes.
- `resolveRequest` (library option) — the adopter's identity system returns the scope key itself.

Data is stored under the syndicate's `memory_namespace` when it declares one, else `melchizedek-a2a` ([ADR 0020](/decisions/0020-memory-contract.md)). `DELETE /memory` erases everything held for the calling scope: facts, sessions with their subagent rows, and ledger rows.

## Which agents are served

A bare `/<agentId>/` is `<agentId>.yaml` in the deployment's agents directory. The shipped `examples/` and `templates/` answer only ids in `A2A_SERVED_AGENTS`, and that list, when set, is the whole served set. The registry answers `registry:<id>`, and bare ids in `A2A_REGISTRY_AGENTS`; a registry miss is a 404 and a registry failure a 503, never a fallback to a file ([ADR 0018](/decisions/0018-files-are-the-source-of-truth.md)). Every load logs its source. A loaded config is cached for the life of the process, so a change needs a restart.

## Limits and lifecycle

Each task has a deadline (`A2A_TASK_TIMEOUT_MS`, default 15 minutes) and a turn-wide model-call cap (the YAML's `max_steps`); `tasks/cancel` aborts the provider call in flight. The rate limit (`A2A_RATE_LIMIT_MAX` per `A2A_RATE_LIMIT_WINDOW_MS` per IP), the failed-login limit, the concurrency cap, trust-proxy and body limit are environment settings. Tasks, the config cache and the limiter counters are per process. The server prints no conversation content unless `OTEL_CONSOLE_SPANS=true`.

## The bindings trap

`{{token}}` bindings evaluate **once per agent load** — at boot for the boot syndicate, at first request for `/<agentId>/` ones. Long-lived deployments must therefore never pass per-request data through bindings: prepend it to the message instead (production practice: a `[System Context: Current Date is …]` line the prompts treat as authoritative over the frozen `{{current_date}}`). Message parts may be text or `data` (sent to the model as JSON); file parts are rejected.

Auth failures and their fixes are catalogued in [failure modes](/operations/failure-modes.md).
