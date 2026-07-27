---
type: protocol
title: A2A
description: Any syndicate as a stateless multi-tenant HTTP API — BYOK headers, dynamic agent-card routes, the Supabase registry, and the compile-time-bindings trap.
tags:
  - a2a
  - protocols
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: scripts/a2a_server.ts
  - resource: DOCUMENTATION.md
    title: '§11 exposing agents over HTTP'
---

# A2A

`npm run start:a2a -- <syndicate>.yaml` serves any [syndicate](/agents/) as a stateless HTTP API on `$PORT` (default 4000): `GET /.well-known/agent-card.json` describes capabilities; `POST /a2a/rest/v1/message:send` triggers a run. Instead of a local file, `registry:<id>` boots from the `adk_agent_registry` Supabase table — agent definitions update globally without redeploying containers.

## Multi-tenant security (BYOK)

The server holds no global model key. Each request carries:

- `Authorization: Bearer <A2A_SERVER_SECRET>` — the deployment gatekeeper (unset = local dev only).
- `X-API-Key` — the caller's own LLM key, so inference bills to the caller. The key is scoped to the **caller's** provider; cross-provider agents in the graph resolve keys from server env instead ([provider routing](/models/provider-routing.md)).
- `X-Provider` — deprecated; only picks a default model when the YAML omits one.

Headers flow through `AsyncLocalStorage`; the `LlmAgent` graph is compiled per request and stays stateless under concurrency.

## The bindings trap

`{{token}}` bindings evaluate **once per agent load** — at boot for static routes, at first request for cached dynamic `/:agentId/` routes. Long-lived deployments must therefore never pass per-request data through bindings: prepend it to the message instead (production practice: a `[System Context: Current Date is …]` line the prompts treat as authoritative over the frozen `{{current_date}}`), and use runtime payload injection — the `parts` array accepts instruction text, raw JSON payloads, and multimodal file URIs in one request context.

Auth failures and their fixes are catalogued in [failure modes](/operations/failure-modes.md).
