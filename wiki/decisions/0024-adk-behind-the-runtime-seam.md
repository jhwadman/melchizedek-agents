---
type: decision
title: 'ADR 0024: Google ADK stays the agent runtime, behind the framework''s own turn runner; A2A is the wire, in both directions'
description: The framework does not replace ADK with "strict A2A" — A2A is a protocol between agents, not a runtime — and does not write its own agent loop now. It owns the seam instead (runSyndicateTurn), keeps ADK types out of its public API, tests the ADK boundary with scripted models, tracks ADK's current major, and speaks A2A 1.0 with 0.3 compatibility as a server and as a client.
tags:
  - decision
  - protocols
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/runtime/syndicateTurn.ts
  - resource: lib/runtime/turnControl.ts
  - resource: lib/a2a/app.ts
  - resource: lib/a2a/remoteAgent.ts
  - resource: tests/syndicateTurn.test.ts
---

# ADR 0024: Google ADK stays the agent runtime, behind the framework's own turn runner; A2A is the wire, in both directions

## Context

The question was whether to leave Google's Agent Development Kit and "build strictly on A2A".

**What each one is.** A2A is a wire protocol between opaque agents: an agent card, message and task methods, transports. It has no model abstraction, no tool-calling loop, no sessions and no memory. ADK is an in-process runtime: the model-to-tool loop, `LlmAgent`, `AgentTool` delegation, the event stream, session appends. Replacing one with the other is a category error. The real alternative was owning the agent loop.

**What the framework already owned.** Four of five model adapters, provider routing and the gateway, plan-dispatch, the transcript projection, persistence, memory and the telemetry ledger. ADK supplied the per-agent loop, `AgentTool`, the Gemini adapter, the base classes and the spans the ledger reads.

**Where the pain actually was.** Every defect an audit traced to "the ADK layer" was in this repository's use of it:

- Adapters read `FunctionTool`'s private `parameters`, so non-Gemini orchestrators could not delegate.
- `max_steps` was passed to a `runAsync` parameter that does not exist.
- Documented YAML fields (`includeContents` and four others) were never forwarded.
- The turn pipeline lived in a server script, copied into the eval harness, with a third builder in the REPL.

None of these is fixed by leaving ADK; all of them are fixed by owning the seam.

**The costs of ADK that are real.**

- ADK 1.x pulled about two-thirds of the install tree (five SQL drivers, GCP exporters). 2.x makes those optional peers.
- Five dependencies on ADK internals: the tracer's proxy field, span names and attributes, the registry's regex identity, `AgentTool`'s private `agent` field, and the `FunctionTool` field the adapters now no longer read.
- ADK TypeScript trails Python, ships no non-Gemini adapters, and its A2A layer is still on protocol 0.3.

## Decision

1. **ADK stays the runtime, behind one framework-owned seam.** `runSyndicateTurn` (`lib/runtime/syndicateTurn.ts`) is the only place a turn runs. The A2A server, the REPL, the worker and the eval harness call it, and the package exports it. It takes YAML config and text parts and returns plain data. ADK's `Runner`, `LlmAgent` and event types do not appear in what callers write against.
2. **Turn-wide controls are the framework's, not ADK's.** `lib/runtime/turnControl.ts` charges every model call — orchestrator, subagents, nested syndicates — against the YAML's `max_steps` from the one choke point every adapter passes (`traceLlmGeneration`). It also carries the turn's abort signal into every provider SDK, so cancel and the deadline stop the request in flight. ADK's own ceiling resets inside each `AgentTool` and cannot bound a turn.
3. **The boundary is tested.** `tests/syndicateTurn.test.ts` drives real ADK objects with scripted models: delegation arguments, the relay fallback, the turn-wide step cap, cancel, deadline, two-turn sessions, `includeContents`, plan-dispatch. `tests/models.test.ts` builds requests from real `AgentTool` and `load_memory` objects for every adapter. An ADK upgrade, or a replacement of the loop, runs against these.
4. **Track ADK's current major.** The framework runs on ADK 2.2 (`@google/genai` 2.25, one copy), with ADK a peer dependency of the package. ADK and genai stay pinned exactly; a bump runs the suite above plus one live turn.
5. **A2A is the wire, both ways.**
   - The server speaks A2A 1.0 with the SDK's 0.3 compatibility on every handler, and a card listing both versions' endpoints (`lib/a2a/app.ts`).
   - A subagent with `a2a_agent_url:` is a remote agent reached over A2A, as a delegation tool or a plan-dispatch route (`lib/a2a/remoteAgent.ts`).
   - In-process composition stays the default, as Google's and Microsoft's A2A guidance both recommend for same-team agents. A2A is for real boundaries: another team, deployment, language or framework.

## Alternatives considered

- **"Strictly A2A": every agent its own A2A server.** Rejected. It adds an HTTP hop, auth and a failure mode to every delegation, and A2A still needs a runtime inside each agent.
- **Own the agent loop now** (about 1,500–2,200 lines: the loop, a Gemini adapter, base classes, memory tools, span emission). Rejected for now. It removes no defect, and Gemini parity (grounding, thought signatures, streaming) is the riskiest part. The seam makes it a contained change later.
- **Adopt another runtime** (Vercel AI SDK, Mastra, LangGraph.js). Rejected. Each is a migration of the same size with its own lock-in, and none removes a defect found here.
- **Stay on ADK 1.x.** Rejected. 1.x stopped at 1.6.0, security fixes since ship only in 2.x, and the package's `^1.3.0` peer range already admitted an untested genai major.

## Consequences

- Revisit owning the loop if one of these holds:
  - an ADK upgrade breaks the boundary suite in a way a version pin cannot hold;
  - ADK drops or stalls its TypeScript line;
  - a required capability (parallel tool calls, a provider feature) can only be had by forking ADK's loop.
- The remaining dependencies on ADK internals (the tracer's proxy adoption, span names, `AgentTool`'s private field in tool replay) stay; the boundary suite and the ledger tests are what notice them breaking.
- A2A remote calls inherit the SSRF guard (`lib/net/addressGuard.ts`) and per-host credentials (`A2A_AGENT_TOKENS`); a remote agent's answer is data to the orchestrator, like any tool result.
- ADK's own A2A helpers (`toA2a`, `RemoteA2AAgent`) stay unused. They are on protocol 0.3, and the framework's own server and client do not depend on ADK.
