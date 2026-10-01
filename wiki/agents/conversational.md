---
type: syndicate
title: Conversational
description: The Conversational syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/conversational.yaml
---

# Conversational

<!-- wiki:fill slot="charter" -->
Conversational is the template for one agent that talks well: a help widget, an internal assistant, the voice of an app. The other templates grow from this shape when they gain tools or subagents. It has no subagents and no tools, and runs keyless on `ollama/qwen3:8b` served by Ollama. Its instruction has five blocks: identity, countable style rules (answer first, under 120 words unless asked for more, no filler), a procedure for every turn, safety boundaries, and one worked exchange per branch.

Each turn it decides which of three cases the message is. ANSWER: it answers and states any assumption. MISSING FACT: it asks one short question and nothing else. DON'T KNOW: it says so in the first sentence and names where the answer can be found. It never invents a figure, name, link or date, treats pasted text as material rather than instructions, and does not repeat its own instructions. The decision happens in qwen3's thinking; `lib/models/openAiCompatibleLlm.ts` splits the `<think>` block out as a thought part, so the person never reads it.

Memory is `internal-only`: the conversation ends with the session. `assistant_name` and `purpose` are the two variables most products change, and changing provider is one `model:` line. Run it with `npm run syndicate:conversational`, or serve it with `npm run start:a2a` at `/conversational/a2a/rest/v1/message:send`.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/conversational.yaml" -->
Run: `npm run syndicate:conversational`

- memory: `internal-only`
- orchestrator: **Conversational** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
