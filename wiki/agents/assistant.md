---
type: syndicate
title: Assistant
description: The Assistant syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-25
sources:
  - resource: config/agents/examples/assistant.yaml
---

# Assistant

<!-- wiki:fill slot="charter" -->
The Assistant is the starter pack's generic starting point: the file to copy when building a personal agent of your own. It runs keyless on a local `ollama/qwen3:8b` and does four things with the smallest mechanism for each. The orchestrator converses and answers directly whenever no tool is needed. A Summarizer subagent condenses pasted text or up to five URLs it reads with `web_extract`. The [task tools](/tools/task-tools.md) keep the user's to-do list in a local store that outlives the conversation. Longer work goes to `task_queue`, which only writes a job; a separate process, `npm run assistant:worker`, runs each queued job through the Worker subagent and writes the result back, and `task_get` reads it in a later turn. The queue is the whole contract between the conversation and the worker, so either side can be replaced. Run `npm run syndicate:assistant` with the worker in a second terminal; before it summarizes URLs, raise Ollama's default 4,096-token context (`OLLAMA_CONTEXT_LENGTH=16384 ollama serve`). The store is single-user: never serve this syndicate on a shared A2A endpoint.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/assistant.yaml" -->
Run: `npm run syndicate:assistant`

- memory: `internal-only`
- orchestrator: **Assistant** (`ollama/qwen3:8b`) · tools: `task_add`, `task_queue`, `task_list`, `task_get`, `task_update`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Summarizer | `ollama/qwen3:8b` | `web_extract` | — |
| Worker | `ollama/qwen3:8b` | `web_extract` | — |
<!-- /wiki:generated -->
