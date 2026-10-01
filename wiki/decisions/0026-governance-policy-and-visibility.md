---
type: decision
title: 'ADR 0026: Governance on the policy plug point — daily budgets per caller and scope, one record per task, Prometheus metrics, ledger redaction'
description: Budgets are checked when a task is admitted and charged when it ends, per UTC day, per caller and per scope, in a SQL counter table shared by every instance. Every task produces one record (structured log line, metrics) labelled by caller, never by user. The telemetry ledger is redacted before it is written, credentials by default. Approval gates for write tools are deferred to their own decision.
tags:
  - decision
  - protocols
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/a2a/policy.ts
  - resource: lib/observability/metrics.ts
  - resource: lib/observability/redact.ts
  - resource: lib/a2a/executor.ts
  - resource: db/migrations/0004_usage.sql
  - resource: tests/governance.test.ts
---

# ADR 0026: Governance on the policy plug point — daily budgets per caller and scope, one record per task, Prometheus metrics, ledger redaction

## Context

[ADR 0017](/decisions/0017-plug-points.md) reserved a `policy` plug point for rate limits, budgets and tool approvals, with no budgets as the default. Until [ADR 0025](/decisions/0025-built-in-authenticators.md), nothing identified a caller, so nothing could be budgeted per caller.

**What an operator could not answer:**
- What each caller spent today.
- Whether one caller could exhaust the provider quota every other caller depends on.
- What happened to a task, without reading free-text logs.
- Whether a pasted API key now sits in the telemetry ledger.

**What the runtime already counted.** The turn already counted model calls (for `max_steps`). The tracer saw every provider's token report, one call at a time, but it did not add them up per turn.

## Decision

1. **A turn reports its spend.** `runSyndicateTurn` returns `usage` (model calls and input, output and thinking tokens), summed across every agent from the same choke point that enforces `max_steps`. Budgets, metrics and the task log all read this one number.
2. **Budgets are checked at admission and charged at the end.**
   - `policy.admit` runs before a task takes a concurrency slot. A refusal ends the task `rejected` with a reason the client can show.
   - `policy.record` runs when the task ends, whatever the outcome: a failed or canceled turn still spent its calls.
   - Tasks already running when the line is crossed are allowed to finish. The overshoot is bounded by the concurrency cap, and no task is cut off halfway through.
   - A policy that cannot read its store refuses. A budget that cannot be checked is not a budget.
3. **The built-in `budgets()` counts per UTC day, per caller and per scope.**
   - It counts tasks, model calls and tokens, with per-caller overrides (`A2A_BUDGETS` JSON).
   - The counters live in `melchizedek_usage` (migration 0004) and are added with one atomic upsert, so every instance shares them. They hold numbers only.
   - Without durable storage they live in process memory, and the boot log says so.
   - Ninety days are kept.
4. **One record per task** (`TaskRecord`): agent, caller, a SHA-256 prefix of the scope, status, reason, duration and usage.
   - `A2A_LOG_FORMAT=json` makes every server line JSON, including this record.
   - `GET /metrics` serves Prometheus text behind its own `A2A_METRICS_TOKEN`; a scraper is not a caller.
   - Labels are agent, outcome and caller name. A scope is never a label: it can name a person, and it would make cardinality unbounded.
5. **The rate limit follows identity.** With an authenticator, the limit is per caller name for an operator's backend and per scope for an end user. Under the shared secret, which identifies nobody, it stays per IP, as before.
6. **The ledger is redacted before it is written.**
   - Every text value in an `adk_turns`, `adk_telemetry` or `adk_payloads` row passes a redactor; identifier columns are left alone so joins hold.
   - Key-shaped credentials are always redacted (`TELEMETRY_REDACT=secret`, the default). Emails, phone numbers, Luhn-valid card numbers and SSNs are redacted on request.
   - `setTelemetryRedactor(fn)` plugs in a DLP service.
   - Sessions and memory are not redacted: they must hold the conversation for the agent to work, and erasure covers them.

## Alternatives considered

- **Reserve the budget at admission** (charge an estimate, then settle). Rejected for now: a turn's cost is not knowable in advance, and an estimate either refuses legitimate work or underestimates. Charging at the end, with the concurrency cap bounding the overshoot, is predictable.
- **Budgets in currency.** Rejected for the built-in. Prices change per model and per provider, and a deployment behind a gateway does not know them. Tokens and calls are what the system observes. A policy plug-in can price them.
- **OpenTelemetry metrics through the existing exporter.** The OTLP trace export already exists for those who run a collector. A Prometheus scrape needs nothing else running, and is what most operators point a dashboard at first.
- **A `prom-client` dependency.** Rejected: the exposition format is a few lines, and the package is a library other projects install.
- **Redact sessions and memory too.** Rejected: an agent that cannot see the user's words cannot answer them. Retention and erasure ([ADR 0020](/decisions/0020-memory-contract.md)) are the controls there.

## Consequences

- An over-budget caller sees a `rejected` task with a reason, not a 429. A client that retries 429s with backoff would not retry a rejected task, which is the right behaviour for a budget that resets at midnight UTC.
- Turning budgets on in a Supabase deployment needs migration 0004 applied first (`melchizedek-db apply`).
- The memory-extraction call that runs after a completed task is outside the turn and is not counted against the caller's budget. It is the operator's cost, bounded by one call per task.
- **Approval gates for tools that write are deferred.** They need the A2A `input-required` state and a resumable turn, which is its own decision.
