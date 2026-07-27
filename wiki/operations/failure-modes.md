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

The model id doesn't exist on the AI Studio endpoint or the account tier lacks access. Use `gemini-3.6-flash` or `gemini-3.1-flash-lite`; identifiers are case-sensitive and must match the AI Studio model list exactly.

## `400` — "tool call context circulation not enabled"

`gemini-2.5-flash` is incompatible with this framework's `includeServerSideToolInvocations: true` on standard AI Studio Tier 1 — which is why it must never be a default model (noted at the constant in `lib/config.ts`). Fix: `model: "gemini-3.6-flash"` in the YAML.

## Orchestrator ignores subagent output / returns stale data

Prompt engineering, not a framework bug: the orchestrator answered from prior context instead of waiting. Mandate in its instruction that it must call subagents and wait for their responses before synthesizing — and end each subagent instruction with a mandatory "return a final text summary to the orchestrator" clause. The deeper design rationale is the isolation argument in [architecture](/overview/architecture.md).

## `Unauthorized: Missing X-API-Key header`

The [A2A server](/protocols/a2a.md) is BYOK — every request needs the caller's model key in `X-API-Key`.

## `Unauthorized: Missing or invalid Authorization Bearer token`

`A2A_SERVER_SECRET` is set server-side but absent from the request. Send `Authorization: Bearer <secret>`, or unset the variable for local development only.

## Silent degradations worth knowing

Two by design, from [tool contracts](/tools/tool-contracts.md) and [MCP](/protocols/mcp.md): an unknown tool name in YAML resolves to a **warning** and the agent runs without it; an unreachable MCP server yields an **empty tool list**, not a crash. A typo therefore produces a capability-less agent that passes tests — check startup warnings.
