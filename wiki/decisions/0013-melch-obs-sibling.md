---
type: decision
title: 'ADR 0013: Model probing and the signal viewer live in a sibling repo, not in the observatory'
description: Build the provider-agnostic eval harness, the unprompted model probe banks and the telemetry viewer as a separate repository (../melch-obs) that reads this framework's ledger and drives its bridge — rather than growing the observatory, which stays welded to the served syndicate graph and the ledger.
tags:
  - decision
  - evals
  - observability
status: stable
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-09-23
sources:
  - resource: observatory/README.md
  - resource: scripts/observatory/bridge.ts
  - resource: db/telemetry.sql
---

# ADR 0013: Model probing and the signal viewer live in a sibling repo, not in the observatory

## Context

Three things were wanted that the observatory ([ADR 0008](/decisions/0008-observatory-harness.md), [ADR 0010](/decisions/0010-calibrated-judgment-loop.md)) does not do: take telemetry signals — input, thinking, output — from any source and grade them; probe bare models, unprompted, with injected problems that measure problem solving, chain-of-thought reasoning and safety; and show the signals and the verdicts in a viewer built for debugging. The observatory's shape argues against adding them there. Its inference is the Node bridge because a syndicate must be the served graph, so it has no provider layer of its own; its record is the bridge's `RunResult`; its persistence is the ledger's `adk_verdicts`; and it ships inside a private repo whose public export is an allowlist.

## Decision

**A sibling repository, `../melch-obs`, with one record shape and its own providers.** Everything in it reads the Signal — a flat, snake-case record with explicit `thinking` and `stop_reason` — and every source is converted at the edge: a ledger row, a bridge `RunResult`, an OTLP span with GenAI attributes, a generic exchange object. Bare models are called through the official SDKs (Anthropic, OpenAI-compatible, Gemini), imported lazily so the core stays standard-library and its tests run offline against a mock provider.

**This repo is consumed, not copied.** A `melchizedek` target sends jobs to `scripts/observatory/bridge.ts`, so a syndicate under test is still the served graph; the ledger is read over PostgREST with the credentials in this repo's `.env`; observatory runs are ingested as they are. Nothing is written back — verdicts and labels stay in Melch Obs's run directories, and the ledger's verdict tables remain the observatory's.

**The judging discipline is ported, not reinvented.** Calibrated judges, bootstrap confidence intervals, paired comparisons, provenance hashes, judge independence and the gate carry over; what changes is the subject (any Signal) and the additions (probe banks as fixed instruments with per-bank judges, facets by category and difficulty, a local viewer whose only write is a human label).

## Consequences

- Two harnesses exist by design: the observatory for syndicate work that must land in the ledger and gate a registry publish; Melch Obs for comparing syndicates with bare models or foreign agents, for choosing a model before it goes into a YAML, and for looking at production telemetry with thinking and verdicts side by side. [The runbook](/operations/melch-obs.md) says which to reach for.
- A ledger schema change ripples into Melch Obs's `from_adk_turn` normaliser; a change to the bridge's job or result shapes ripples into its `melchizedek` target. Both are read-side dependencies on this repo's public-facing contracts (`lib/evals/types.ts`, `db/telemetry.sql`) and are listed in the runbook.
- The public mirror, the npm package and the teaching site are untouched: Melch Obs is not exported from here and does not import from the package.
