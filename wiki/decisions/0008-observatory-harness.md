---
type: decision
title: 'ADR 0008: Evals drive the production compiler through a bridge; judges are agents'
description: Build the eval harness in dependency-free Python over an NDJSON bridge into the engine, extract the A2A server's compiler so evals run the served graph, and implement LLM judges as structured-output agents rather than a separate client.
tags:
  - decision
  - evals
  - observability
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-22
sources:
  - resource: lib/compile.ts
  - resource: lib/evals/runSyndicate.ts
  - resource: scripts/observatory/bridge.ts
  - resource: observatory/README.md
---

# ADR 0008: Evals drive the production compiler through a bridge; judges are agents

## Context

The repo had two tiers of tests — offline configuration invariants and a live smoke test — and no way to ask how *well* a syndicate answers, whether a model or thinking-level change helped, or whether production replies still obey the house rules. Tests were wanted in Python, composable across three grading styles (a script, a rubric judged by a model, a golden reference), and applicable both before deployment and to traces already stored in the database.

Three shapes were considered for where inference happens: a Python reimplementation of the YAML-to-ADK compiler against provider SDKs; driving the A2A HTTP server as a black box; or a thin Node process that reuses the engine in-process.

## Decision

**A Node bridge, fed NDJSON by a standard-library Python harness.** The harness owns what varies per experiment — suites, datasets, judges, scoring, reports — and has no dependencies, so `python3 -m observatory` runs on a bare interpreter. Everything that touches a model runs in `scripts/observatory/bridge.ts`, in the same process image as the server: same provider registry, same tracer, same tools.

**The server's compiler moved to `lib/compile.ts`.** The A2A executor's `compileGraph` / `compileSubagent` closures became a module with model resolution and nested-config loading injected, and the server now calls it. This is the only way an eval can claim to measure the served graph; a second compiler would be a second place to drift, which is how `lib/toolRegistry.ts` came to exist. The turn loop itself (`lib/evals/runSyndicate.ts`) mirrors the executor's rules with the shared building blocks — route overrides, the classifier digest, the projected transcript, the DELEGATE relay fallback — rather than sharing the executor, which is welded to the A2A event bus.

**Judges are agents.** A rubric becomes an `outputSchema`; an LLM judge is an `LlmAgent` run through the bridge. No provider SDK in Python, any registry-routable model can judge, and judge calls are traced like any other call.

**Variants are overrides on the production YAML**, applied in memory and through every `yaml_reference`, so the only difference between two variants is the override that names it.

**Post-deployment reads Supabase directly** over PostgREST with the standard library, shaping `adk_sessions` exchanges and `adk_telemetry` root spans into the same record the bridge produces, so judges are source-agnostic.

## Consequences

Tracing had to become honest before any of this could score production. Three gaps closed in the same pass: the plan-dispatch route is now a root-span attribute rather than a console line; every `llm.request` span names its agent; and ADK's own spans — which had been silent no-ops because ADK's private `@opentelemetry/api` copy captured a provider-less tracer at import time — now export, which is what makes per-agent attribution possible. The durable sink itself remains opt-in and was found unprovisioned on every deployment; `doctor` reports that state.

The black-box alternative was rejected because the server hides what an eval most needs — per-call tokens, the route, tool calls — behind `[STATUS]` lines, and because BYOK auth and rate limiting exist to protect production, not to be driven by a test loop. The Python-reimplementation alternative was rejected for the drift it guarantees.

The standing risks: `runSyndicate.ts` and the executor must change together when turn semantics change (both headers say so), and eval runs are stateless — no durable session, no long-term memory — so memory-dependent behaviour is not what the harness measures. The observatory is private to this repo until it is allowlisted for export; `lib/compile.ts` is allowlisted because the exported server imports it.
