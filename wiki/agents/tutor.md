---
type: syndicate
title: Tutor
description: The Tutor syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/tutor.yaml
---

# Tutor

<!-- wiki:fill slot="charter" -->
The Tutor syndicate serves as the curriculum's first specimen, demonstrating how structured prompt instructions transform an open-weight general model into a dedicated instrument. It operates without subagents, tools, API keys, or a database, relying on a locally served `ollama/qwen3:8b` model. It teaches whatever the user brings, a topic named in a sentence or material pasted into the conversation, by asking questions rather than lecturing. Pasted material is ground truth; without it, the Tutor teaches from what is well established and says when it is unsure. Its instruction has four blocks: `<system_identity>`, `<communication_style>`, `<execution_framework>` and `<examples>`. Run `npm run syndicate:tutor` for local, question-led teaching of one topic or text.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/tutor.yaml" -->
Run: `npm run syndicate:tutor`

- memory: `internal-only`
- orchestrator: **Tutor** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
