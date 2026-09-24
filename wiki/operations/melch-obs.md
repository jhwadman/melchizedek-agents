---
type: runbook
title: Melch Obs — the sibling eval and telemetry viewer
description: The standalone sibling repo (../melch-obs) that ingests this framework's ledger and observatory runs, runs its syndicates through the observatory bridge, probes bare models unprompted, and shows every signal in a local web viewer.
tags:
  - operations
  - evals
  - observability
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-09-23
sources:
  - resource: scripts/observatory/bridge.ts
  - resource: db/telemetry.sql
  - resource: observatory/README.md
---

# Melch Obs

`../melch-obs` is a separate repository (Python 3.11+, standard-library core, provider SDKs as optional extras) that evaluates anything able to produce one record — the **Signal**: input, thinking, output, tool calls, tokens, latency, stop reason, error. It is the provider-agnostic sibling of [the observatory](/operations/observatory.md): the same judging discipline (calibrated judges, bootstrap confidence intervals, provenance hashes, gates), applied to bare models and foreign agents as well as to this framework's syndicates, plus a probe harness and a viewer the observatory does not have.

## What it reads from this repo

| surface here | how Melch Obs uses it |
|---|---|
| the ledger (`adk_turns`, `adk_telemetry`; [ADR 0009](/decisions/0009-observability-ledger.md)) | `melchobs ingest supabase` and `[source] type = "supabase_turns"` read production turns over PostgREST with the service-role key from this repo's `.env`, strip the `[System Context: ...]` prefix, attach per-call `llm.request` rows, and shape each row into a Signal. Read-only; nothing is written back. |
| `scripts/observatory/bridge.ts` | a `kind = "melchizedek"` target sends one NDJSON `run` job per case, so a Melch Obs suite runs the exact graph the [A2A server](/protocols/a2a.md) serves, with `EvalOverrides` mapped from the target's model, thinking, temperature and prompt suffix. Located by `MELCHIZEDEK_DIR` (default `../melchizedek`). |
| `observatory/runs/<run>/runs.jsonl` | `melchobs ingest <run dir>` and `[source] type = "observatory_run"` convert `RunResult` records (camelCase) into Signals — thoughts preview, delegations, route, relay fallback, per-call models. |
| the A2A server | a `kind = "a2a"` target speaks JSON-RPC `message/send` to `<url>/a2a/jsonrpc` with the `X-API-Key` header, one `contextId` per case. |
| `.env` | the workspace credential root: Melch Obs loads `../melchizedek/.env` when it has no `.env` of its own. |

It writes nothing into this repository. Verdicts stay in its own `runs/` directories; the ledger's `adk_verdicts` and `adk_labels` tables are the observatory's.

## What it adds

- **Targets beyond syndicates** — bare models through the Anthropic, OpenAI-compatible (OpenAI, xAI, Ollama) and Gemini SDKs, any A2A agent, a shell command.
- **The probe harness** — three fixed banks of forty unprompted problems each (`problem_solving`, `reasoning` with the chain of thought as the graded subject, `safety` covering harmful requests, over-refusal, prompt injection, sycophancy, honesty, privacy), graded by answer extraction, refusal detection and scoped LLM rubrics, reported by category and difficulty.
- **The viewer** — `melchobs serve`: runs, scores with confidence intervals, facets, and the signal itself (input, thinking, output, tool calls, verdicts) with one-click human labels that recompute calibration.

## Beside ymir

`../ymir` is the hosted, password-protected, read-only page over the same ledger for the financial Discord desk (a Postgres reader role, Vercel). Melch Obs absorbed its analytical views — payload hydration, the overview strip and activity buckets, the per-session thread, the surface dimensions — as local, service-role-key reads, and adds what ymir cannot do: run targets, probe models, judge locally, calibrate. ymir keeps what Melch Obs deliberately does not have: a URL other people can open, and a judge turn that lands in the ledger through `ymir_judge`.

## When to use which

Use the observatory for syndicate work that must land in the ledger (persisted verdicts, `deploy_agent.ts --gate`, alerts). Use Melch Obs to compare a syndicate against a bare model or a foreign agent, to probe a model before choosing it in a YAML (see [provider routing](/models/provider-routing.md)), or to look at production telemetry with the thinking and the verdict side by side. The rationale for keeping them separate is [ADR 0013](/decisions/0013-melch-obs-sibling.md).
