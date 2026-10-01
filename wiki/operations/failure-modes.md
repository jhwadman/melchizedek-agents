---
type: runbook
title: Failure modes
description: The named errors newcomers actually hit — model-tier 503s, the gemini-2.5-flash tool-context 400, stale-orchestrator synthesis, and the two A2A auth rejections — with their fixes.
tags:
  - operations
  - troubleshooting
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: QUICKSTART.md
    title: 'Common Errors & Fixes'
  - resource: lib/config.ts
---

# Failure modes

## `503 ServiceUnavailable` on inference

The model id doesn't exist on the AI Studio endpoint or the account tier lacks access. Use `gemini-3.8-flash` or `gemini-3.1-flash-lite`; identifiers are case-sensitive and must match the AI Studio model list exactly. A 503 whose message says "high demand" on a VALID model id is different: Google's capacity spike, transient — and the framework now retries it for you. Every provider gets the same policy (`lib/models/retry.ts`): 3 attempts in total (`MODEL_RETRY_MAX_ATTEMPTS`, 1 disables), full-jitter backoff from 500 ms to an 8 s ceiling, on 408/409/425/429/500/502/503/504 and connection resets — never on any other 4xx, and never on a refused connection (a stopped Ollama is reported at once). A `Retry-After` (or Gemini's `retryDelay`) is waited out up to 60 s; longer than that means a quota waiting won't fix, so the call fails immediately. A cancel or deadline wakes the backoff and stops the retries, and nothing is retried once the reply has started streaming, so a retry never repeats text. Gemini and the chat-completions path (Ollama, gateways) use the shared helper; Claude and GPT/Grok keep their SDKs' equivalent two retries. Each `llm.request` span records `llm.retries` and `llm.http_status`, so a ledger row shows whether a turn survived a 503 or died of one. If a 503 still surfaces after all that, the spike outlasted every attempt: retry later.

A failed turn's reason now reaches the surface: `failTask` embeds the upstream provider message via `describeTurnError` (`scripts/a2a_server.ts` — JSON ApiError blobs unwrapped, 300-char cap) in the task's `status.message`, and the Discord client renders it. Before 2026-08-27 the user saw `Agent task TASK_STATE_FAILED: Unknown error` for every failure, whatever the cause.

## `400` — "tool call context circulation not enabled"

`gemini-2.5-flash` is incompatible with this framework's `includeServerSideToolInvocations: true` on standard AI Studio Tier 1 — which is why it must never be a default model (noted at the constant in `lib/config.ts`). Fix: `model: "gemini-3.8-flash"` in the YAML.

## Orchestrator ignores subagent output / returns stale data

Prompt engineering, not a framework bug: the orchestrator answered from prior context instead of waiting. Mandate in its instruction that it must call subagents and wait for their responses before synthesizing — and end each subagent instruction with a mandatory "return a final text summary to the orchestrator" clause. The deeper design rationale is the isolation argument in [architecture](/overview/architecture.md).

## `Unauthorized: Missing X-API-Key header`

The [A2A server](/protocols/a2a.md) is in BYOK mode (`A2A_KEY_MODE=byok`), where every task request carries the caller's model key. In the default server mode the header is not used; a server that warns "A caller sent X-API-Key" is telling a BYOK client it is talking to a server-mode deployment.

## `Unauthorized: Missing or invalid Authorization Bearer token`

`A2A_SERVER_SECRET` is set server-side but absent from the request. Send `Authorization: Bearer <secret>`. Unsetting it makes the server bind `127.0.0.1` only. Thirty failed attempts from one IP in 15 minutes block that IP for the window (`A2A_AUTH_FAILURE_MAX`).

## `STEP_LIMIT`, `DEADLINE_EXCEEDED`, `CANCELED`

A turn stopped by its controls: the YAML's `max_steps` counts model calls across every agent the turn reaches, `A2A_TASK_TIMEOUT_MS` bounds wall-clock time, and `tasks/cancel` stops it. The provider call in flight is aborted, not left running.

## `Unknown agent '<id>'` (404) and `is unavailable` (503)

A bare id must be a file in the agents directory; examples and templates answer only ids in `A2A_SERVED_AGENTS`, and registry ids need `registry:<id>` or `A2A_REGISTRY_AGENTS`. A 503 means the agent exists but its config is invalid or the registry is unreachable — the server log names which.

## `GATEWAY_HTTP_ERROR` / `GATEWAY_KEY_MISSING` / `GATEWAY_NOT_CONFIGURED`

Only seen when `MODEL_GATEWAY` is set ([provider routing](/models/provider-routing.md)). `GATEWAY_KEY_MISSING`: the gateway is named but `MODEL_GATEWAY_API_KEY` is not set — the registry log says so at startup and the doctor marks every uncovered provider blocked. `GATEWAY_NOT_CONFIGURED`: the value is not `vercel` or `openrouter`. `GATEWAY_HTTP_ERROR` with a 400 or 404 is almost always the wire name — the gateway's id for the model differs from the mapper's guess; fix it once with `MODEL_GATEWAY_MODEL_MAP=<yaml id>=<gateway id>`. A gateway path never carries native search: an agent declaring `web_search` on it runs without search, and that is reported (`capability ·` line at compile time, `llm.capability.dropped` on the span), not a fault.

## Silent degradations worth knowing

Two by design, from [tool contracts](/tools/tool-contracts.md) and [MCP](/protocols/mcp.md): an unknown tool name in YAML resolves to a **warning** and the agent runs without it; an unreachable MCP server yields an **empty tool list**, not a crash. A typo therefore produces a capability-less agent that passes tests — check startup warnings.
