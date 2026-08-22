---
type: decision
title: 'ADR 0009: One ledger for turns, spans and payloads — not sessions'
description: Record every turn as a first-class row with identity and provenance, keep full model payloads in their own policy-sampled expiring table, and leave adk_sessions as runtime state — rather than loading sessions with request/response payloads.
tags:
  - decision
  - observability
  - telemetry
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-22
sources:
  - resource: db/telemetry.sql
  - resource: lib/observability/supabaseSpanExporter.ts
  - resource: lib/observability/lineage.ts
  - resource: lib/observability/tracer.ts
---

# ADR 0009: One ledger for turns, spans and payloads — not sessions

## Context

Research-grade observability was wanted: store every exchange as input and output under an id, connect it to the session it belonged to, keep the full model request and response for "maximum visibility", and be able to search old queries, grade stored answers, and back-test new configurations on real traffic. The natural-sounding proposal was to keep traces for live debugging and put the full payloads into the session log.

Three facts about the existing stores shaped the answer. The root span carried no session, task, or invocation id, the chosen route existed only as a console line, and the classifier ran untraced — so traces and sessions could only be matched by timestamp. `adk_sessions` is the ADK runner's working memory: re-read before every model call, re-upserted whole on every append (a 60-turn thread already costs ~59 MB of cumulative upload after the 2026-08-15 trimming), read by the memory pipeline, and expired after seven days. And full payloads measured at 10–100x a turn row, repeating the growing history on every call.

## Decision

**Sessions stay runtime state.** Nothing observability-related is added to `adk_sessions`; it is joined *to*, by `session_id` (the A2A `contextId`) and `invocation_id` (ADK's per-turn id, present on every stored event).

**A turn is the unit of record.** `adk_turns` holds one row per turn with everything a judge, a dashboard, or a replay needs as columns: input, output, the responding agent, the plan-dispatch route with its reason and fallback flags, the relay-fallback flag, errors, tokens, latency split into model and tool time, the tool calls with their full responses, the five ids, and provenance — `config_hash`, a digest of the fully resolved syndicate (nested references inlined), and `engine_version`. It is full-text indexed and kept indefinitely. The classifier's own turn is recorded too (`stage = classify`), so misroutes are diagnosable; a view, `adk_turns_production`, shows only what users received.

**Payloads are a separate tier with a policy and a clock.** ADK's `call_llm` spans — the assembled prompt and the raw response — go to `adk_payloads` for every turn that errored or fell back, for a deterministic per-trace sample of the rest (10% by default), or for all turns; rows expire after 30 days by default and a SQL function prunes them. The exporter holds a turn's payload spans until its root span arrives, then applies one decision to all of them.

**Raw spans remain.** `adk_telemetry` keeps one row per `llm.request` and root span, now with the identity columns and the agent that made each call, and the spans also carry the OpenTelemetry GenAI semantic conventions so an OTLP viewer can be attached without migration.

**The pipeline reports on itself.** Failed inserts are spooled to a dead-letter file and replayable; `telemetry:stats` and the observatory's `doctor` show rows per day and write lag.

## Consequences

Every question that motivated this is now a query: a conversation with its stored events per turn, routing mix and fallback rate per route, cost per agent per day, a full-text search over old inputs and outputs, and a comparison of any metric across `config_hash` values — which also exposes registry-versus-file drift for the first time. The observatory grades production out of `adk_turns` and tags its own eval rows so they never contaminate production views; later phases (persisted verdicts and human labels, gates before deploy, replay with recorded tool responses) build on the same rows.

The costs are deliberate. The ledger duplicates the input and output text that sessions also hold for seven days; that redundancy is what survives session expiry. `adk_turns` and `adk_payloads` contain user text and prompts and are locked down by `hardening.sql`, but retention beyond payloads is the operator's decision. The relay-fallback flag is known only after the stream is drained, so the executor reports it through an `onEnd` hook rather than the tracer inferring it. And the payload sample is deterministic in the trace id, so the sampled set is reproducible but not random across re-runs of the same traffic.
