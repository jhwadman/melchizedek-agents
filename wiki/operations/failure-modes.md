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

The model id doesn't exist on the AI Studio endpoint or the account tier lacks access. Use `gemini-3.8-flash` or `gemini-3.1-flash-lite`; identifiers are case-sensitive and must match the AI Studio model list exactly. A 503 whose message says "high demand" on a VALID model id is different: Google's capacity spike, transient, retry later.

A failed turn's reason now reaches the surface: `failTask` embeds the upstream provider message via `describeTurnError` (`scripts/a2a_server.ts` — JSON ApiError blobs unwrapped, 300-char cap) in the task's `status.message`, and the Discord client renders it. Before 2026-08-27 the user saw `Agent task TASK_STATE_FAILED: Unknown error` for every failure, whatever the cause.

## `400` — "tool call context circulation not enabled"

`gemini-2.5-flash` is incompatible with this framework's `includeServerSideToolInvocations: true` on standard AI Studio Tier 1 — which is why it must never be a default model (noted at the constant in `lib/config.ts`). Fix: `model: "gemini-3.8-flash"` in the YAML.

## Orchestrator ignores subagent output / returns stale data

Prompt engineering, not a framework bug: the orchestrator answered from prior context instead of waiting. Mandate in its instruction that it must call subagents and wait for their responses before synthesizing — and end each subagent instruction with a mandatory "return a final text summary to the orchestrator" clause. The deeper design rationale is the isolation argument in [architecture](/overview/architecture.md).

## `Unauthorized: Missing X-API-Key header`

The [A2A server](/protocols/a2a.md) is BYOK — every request needs the caller's model key in `X-API-Key`.

## `Unauthorized: Missing or invalid Authorization Bearer token`

`A2A_SERVER_SECRET` is set server-side but absent from the request. Send `Authorization: Bearer <secret>`, or unset the variable for local development only.

## `GATEWAY_HTTP_ERROR` / `GATEWAY_KEY_MISSING` / `GATEWAY_NOT_CONFIGURED`

Only seen when `MODEL_GATEWAY` is set ([provider routing](/models/provider-routing.md)). `GATEWAY_KEY_MISSING`: the gateway is named but `MODEL_GATEWAY_API_KEY` is not set — the registry log says so at startup and the doctor marks every uncovered provider blocked. `GATEWAY_NOT_CONFIGURED`: the value is not `vercel` or `openrouter`. `GATEWAY_HTTP_ERROR` with a 400 or 404 is almost always the wire name — the gateway's id for the model differs from the mapper's guess; fix it once with `MODEL_GATEWAY_MODEL_MAP=<yaml id>=<gateway id>`. A gateway path never carries native search: an agent declaring `web_search` on it runs without search, and that is reported (`capability ·` line at compile time, `llm.capability.dropped` on the span), not a fault.

## Silent degradations worth knowing

Two by design, from [tool contracts](/tools/tool-contracts.md) and [MCP](/protocols/mcp.md): an unknown tool name in YAML resolves to a **warning** and the agent runs without it; an unreachable MCP server yields an **empty tool list**, not a crash. A typo therefore produces a capability-less agent that passes tests — check startup warnings.
