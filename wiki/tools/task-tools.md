---
type: tool
title: Task tools
description: A to-do list and a background-job queue in one local store; the tools write the queue, a separate worker runs it.
tags:
  - tools
  - tasks
generated:
  by: process:wiki-build
  at: 2026-09-25
sources:
  - resource: lib/tools/taskTools.ts
  - resource: scripts/assistant_worker.ts
---

# Task tools

One store holds two kinds of record: `todo` (the user's own tasks: open → done | cancelled) and `background` (jobs: queued → running → done | failed). The store is a JSON file written atomically, at `MELCHIZEDEK_TASKS_FILE` or `outputs/tasks.json` under the working directory: deployment config, never YAML and never an argument. Every call re-reads it, so the conversation and the worker see each other's writes.

<!-- wiki:generated section="contracts" source="lib/tools/taskTools.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `task_add` | `title`, `notes?`, `due?` | Add a task to the user's own to-do list: something THEY need to do or remember. |
| `task_queue` | `title`, `instruction` | Queue a background job: work that takes a while (reading several pages, a long draft, a comparison) and should not block the conversation. |
| `task_list` | `status`, `kind` | List the user's tasks and background jobs, one line each with id, status, and title. |
| `task_get` | `id` | Read one task or background job in full, including a finished job's result. |
| `task_update` | `id`, `status?`, `title?`, `notes?`, `due?` | Change a task: mark it done, cancel it, reopen it, or edit its title, notes, or due date. |
<!-- /wiki:generated -->

**The tools never run a job.** A tool that runs agents is the composite the [tool contract](/tools/tool-contracts.md) refuses, so `task_queue` only writes a record, and `scripts/assistant_worker.ts` (`npm run assistant:worker`; `melchizedek-worker` in the package) runs it: it claims the oldest queued job, runs its instruction as a fresh single turn through one agent compiled by `lib/compile.ts` (default: the [Assistant](/agents/assistant.md)'s Worker; any syndicate and agent will do), and writes the result or the error back for `task_get`. A job left running by a dead worker is re-queued at the next start and failed after two interruptions; one still running after ten minutes is recorded as failed. Run one worker per store: the claim is a read-modify-write, not a lock.

Exposure: the store is single-user and has no caller identity, and neither does the A2A server, so on a shared endpoint every caller would share one list. A syndicate carrying these tools is for one person's machine. A job result is the worker's output and reaches the Assistant as material to report, never as instructions.
