---
type: decision
title: 'ADR 0015: Background work is a queue the tools write and a separate worker drains, not a tool that runs agents'
description: The starter pack's generic Assistant queues long work with a tool that only writes a record to a local store; a plain process claims each record, runs it through one agent compiled from YAML, and writes the result back — rather than a tool that runs a subagent asynchronously, or an in-process job runner inside the server.
tags:
  - decision
  - tools
  - starter-pack
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-09-25
sources:
  - resource: lib/tools/taskTools.ts
  - resource: scripts/assistant_worker.ts
  - resource: config/agents/examples/assistant.yaml
---

# ADR 0015: Background work is a queue the tools write and a separate worker drains, not a tool that runs agents

## Context

The starter pack taught specimens (a tutor, a council, a news synthesis) but had no generic assistant to start from: nothing that converses, summarizes, keeps a to-do list between conversations, and hands off work that should not block the conversation. The first three are a prompt, a subagent with `web_extract`, and a small store. The fourth needs something to run the work after the turn that asked for it has ended, and three shapes were considered: a tool that starts a subagent asynchronously and returns a job id; a job runner inside the process that serves the conversation; a queue that tools write and a separate process drains.

## Decision

The queue. [The task tools](/tools/task-tools.md) keep to-dos and jobs in one local JSON store, and `task_queue` only writes a record with a self-contained instruction. `scripts/assistant_worker.ts` is a plain process (a bin in the package, `melchizedek-worker`) that claims the oldest queued record, runs its instruction as a fresh single turn through one agent compiled by `lib/compile.ts` — by default the [Assistant](/agents/assistant.md)'s Worker, but any syndicate and any agent in it — and writes the result or the error back, where `task_get` reads it in a later turn.

A tool that runs a subagent is the composite the [tool contract](/tools/tool-contracts.md) refuses (the `wiki_query`/`wiki_garden` rule): it hides an agent behind a function, so the agent's model, tools and cost stop being visible in the YAML that authorizes them. An in-process runner ties a job's life to the conversation's process and, inside the A2A server, to a multi-tenant host with no caller identity. The queue keeps the tools primitive, keeps the worker's agent declared in YAML, survives either process restarting, and lets each side be swapped: `--once` under cron, or any syndicate as the worker.

## Consequences

- The store is single-user. Neither it nor the A2A server knows who is asking, so a syndicate carrying the task tools must not be served on a shared endpoint. This is stated in the tool file, the YAML header, and the documentation; it is not enforced in code.
- One worker per store: the claim is a read-modify-write, not a lock. A second worker could claim the same job in a narrow race.
- The worker never sees the conversation. `task_queue`'s description and the Assistant's instruction both demand a self-contained instruction, and a job that needed context the Assistant left out produces a weaker result rather than an error.
- The package gains a fifth bin and five registered tools, a versioned surface ([ADR 0007](/decisions/0007-engine-as-package.md)).
