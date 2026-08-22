---
type: runbook
title: The observatory
description: How syndicates are evaluated — pre-deployment suites (variants x cases x trials, graded by script, rubric, or golden reference) and post-deployment grading of stored traces — and what the engine records to make that possible.
tags:
  - operations
  - evals
  - observability
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-22
sources:
  - resource: observatory/README.md
  - resource: lib/evals/runSyndicate.ts
  - resource: lib/observability/tracer.ts
---

# The observatory

`observatory/` is the eval harness: a zero-dependency Python package (`python3 -m observatory`) that runs a syndicate over a dataset under controlled **variants** — model, thinking level, prompt patch, or a different syndicate — grades every run with one or more **judges**, and writes a report (terminal, Markdown, self-contained HTML, JSON). Python owns suites, datasets, judges and reports; inference is delegated over NDJSON to `scripts/observatory/bridge.ts`, which compiles the same agent graph the [A2A server](/protocols/a2a.md) serves.

## Three judges, three boilerplates

| kind | what decides | boilerplate |
|---|---|---|
| `programmatic` | a script: checks on the run (length, emoji, route, tools, latency...), an extracted value compared with the case's `expected` (accuracy, precision/recall, confusion matrix), or a custom `judge.py` | `suites/programmatic/` — a boolean fact checker over 30 labelled claims |
| `llm` | a rubric (criteria with scales and weights) turned into a structured-output schema that a judge model fills in | `suites/llm_judge/` — the delegation router on correctness, completeness, clarity, right specialist |
| `golden` | the `llm` judge with the reference answer in its prompt and a default correctness/completeness rubric | `suites/golden/` — a concierge agent against expert reference answers |

A judge is an `LlmAgent` with an `outputSchema`, routed through the same [provider registry](/models/provider-routing.md) as every syndicate — any `gemini-*`, `claude-*`, or `ollama/*` model can grade. Judges stack: the shipped suites pair a rubric with a script that knows facts the model cannot (which subagent was consulted, whether the DELEGATE relay fallback fired).

## Post-deployment

`kind = "post_deploy"` suites read finished runs from Supabase instead of running anything: `adk_sessions` (every user turn and its reply, with tool calls — available on any deployment that persists sessions) or the `adk_turns` ledger (input, output, route, agent, errors, tokens, latency, tool evidence, provenance — needs `TELEMETRY_SUPABASE=true` and `db/telemetry.sql`; with session-event and per-call hydration on request). The rows are shaped into the same records, so the same judges apply; eval traffic is excluded by its `eval_*` columns.

## What the engine records

With `TELEMETRY_SUPABASE=true` the tracer's spans land in the observability ledger (`db/telemetry.sql`): `adk_turns`, one row per turn — input, output, the responding agent, the plan-dispatch route and how it was decided, errors, tokens, model-vs-tool latency, the tool calls with their full responses, and the ids that join the row to its `adk_sessions` events (`session_id` + `invocation_id`) and to its task — plus provenance (`config_hash` of the resolved syndicate, `engine_version`); `adk_telemetry`, one row per span; and `adk_payloads`, full prompts and responses by policy with a 30-day expiry. `stage` distinguishes `delegate`, `dispatch`, `classify` (the router's own decision, previously invisible) and `judge`; eval rows carry `eval_*` tags and are excluded from the `adk_turns_production` view. The rationale — why payloads do not belong in sessions, why identity and provenance are on every row — is [ADR 0009](/decisions/0009-observability-ledger.md); the ADK-span fix that makes per-agent attribution possible is [ADR 0008](/decisions/0008-observatory-harness.md).

## The rest of the loop

Every pass rate and score carries a seeded bootstrap confidence interval, and a multi-variant run reports paired-by-case differences with a significance flag. `run --persist` writes verdicts to `adk_verdicts` with `judge_hash`, `dataset_hash` and `config_hash`; `observatory label` collects human labels (judge verdict hidden until answered) into `adk_labels`, and `calibrate` reports each judge's agreement and Cohen's κ — a judge below its κ floor cannot decide a gate. A `pairwise` judge compares two answers in both orders and counts order disagreements as position bias. `observatory gate <suite>` compares a run with a pinned, committable baseline under the suite's `[gate]` thresholds and exits non-zero on a regression; `scripts/deploy_agent.ts --gate <suite>` runs it before publishing to the registry — the deploy runbook's new first step. A `replay` source re-runs stored production turns with their recorded tool responses injected (`lib/evals/toolReplay.ts`) and judges them head-to-head against the stored answer. `search` (full-text and semantic), `tail`, `show <trace>` and `alerts` (rules in `observatory/alerts.toml`, posted to a webhook) read the ledger; KPI views serve dashboards; `OTEL_EXPORTER_OTLP_ENDPOINT` adds a live trace viewer. Rationale: [ADR 0010](/decisions/0010-calibrated-judgment-loop.md).

## Running it

```
python3 -m observatory doctor                  # node, keys, Supabase, telemetry sink
python3 -m observatory run programmatic
python3 -m observatory run llm_judge --persist
python3 -m observatory label latest --sample 20 && python3 -m observatory calibrate latest
python3 -m observatory baseline llm_judge && python3 -m observatory gate llm_judge
python3 -m observatory run replay --limit 20
python3 -m observatory run post_deploy --since-hours 72
python3 -m observatory search "PEG ratio" --semantic
python3 -m observatory tail --follow
python3 -m observatory alerts --dry-run
```

Runs land in `observatory/runs/<stamp>-<suite>/`; `summary.json` is the contract for custom dashboards. Field-by-field configuration, the check catalogue, the rubric format, SQL over the ledger, and extension points are in `observatory/README.md`.
