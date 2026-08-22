---
type: decision
title: 'ADR 0010: A judgment is evidence only with a confidence interval, a human check, and a hash'
description: Persist every verdict with its provenance, calibrate judges against human labels before letting them gate, report uncertainty on every number, replay real traffic with recorded tool data, and make the deploy step ask the question automatically.
tags:
  - decision
  - evals
  - observability
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-22
sources:
  - resource: observatory/calibration.py
  - resource: observatory/gate.py
  - resource: observatory/judges/pairwise.py
  - resource: lib/evals/toolReplay.ts
---

# ADR 0010: A judgment is evidence only with a confidence interval, a human check, and a hash

## Context

[ADR 0008](/decisions/0008-observatory-harness.md) gave the repo an eval harness and [ADR 0009](/decisions/0009-observability-ledger.md) a ledger of what production did. Both produce numbers — pass rates, scores, wins — and numbers from an LLM judge over a handful of cases are the easiest thing in this field to over-trust. The first live rubric run showed the failure in miniature: a script judge passed an answer that contained no code, the rubric judge failed it, and without a human in the loop there was no way to say which judge to believe. The standard asked for was "research-grade": results that could be defended.

## Decision

Five rules, each implemented as code rather than as advice.

**Every number carries its uncertainty.** Pass rates and mean scores report a seeded bootstrap confidence interval; variant comparisons are paired by case with a CI on the difference and an explicit `significant` flag. Three cases will almost never be significant, and the report says so.

**Judges are calibrated, not assumed.** Human labels (`observatory label`, judge verdict hidden until the person answers) persist in `adk_labels` keyed by the turn, so they outlive re-judging. `calibrate` reports agreement and Cohen's κ per judge, splitting disagreement into lenient and harsh. A gate can require a κ floor; an uncalibrated judge is warned about, a poorly calibrated one is blocked from deciding.

**Verdicts are provenance-stamped and additive.** `adk_verdicts` rows carry `judge_hash` (rubric, model, thresholds, script content), `dataset_hash`, `config_hash` and `run_id`; a re-judge is a new row beside the old one.

**Comparisons are pairwise with the order swapped.** A forced choice between two answers is the more reliable signal than absolute scores, and position bias is the known failure; judging both orders and counting disagreement as a tie turns the bias into a measured rate rather than a hidden one. The same judge compares a variant against the stored production answer in a replay, where the recorded tool responses are injected so the world is held constant and only the change under test varies.

**The deploy step asks the question.** `observatory gate` reduces a run, a baseline and thresholds to an exit code, and the registry publish script refuses on it unless forced. Baselines are self-contained and committable, so CI can gate without the original run directory.

## Consequences

Reports are slower to read and harder to over-claim from: a cell is a number with brackets, a comparison has a significance column, a judge has a κ. The human-label loop is work the operator has to do — the harness makes it a ten-minute session rather than a spreadsheet, and the κ it yields is what earns a judge the right to block a deploy. Replay is honest about its limits in the suite header: single-turn, no memory, tools without a recording run live. Alerts and KPI views make the ledger observable without a reader; an OTLP endpoint adds a viewer without moving the system of record.
