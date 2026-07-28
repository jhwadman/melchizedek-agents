---
type: syndicate
title: Tutor
description: The Tutor syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-28
sources:
  - resource: config/agents/tutor.yaml
---

# Tutor

<!-- wiki:fill slot="charter" -->
The Tutor syndicate serves as the curriculum's first specimen, demonstrating how structured prompt instructions transform an open-weight general model into a dedicated instrument. It operates without subagents, tools, API keys, or a database, relying on a locally served `ollama/qwen3:8b` model. The syndicate excels at teaching user-supplied study materials—such as lecture notes, documentation, articles, or textbook passages—by asking questions rather than lecturing. It grounds every explanation in the provided text, defines technical terms on first use, and leads users through the material step by step. Run `npm run syndicate:tutor` when a user needs local Socratic instruction to master specific written material.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/tutor.yaml" -->
Run: `npm run syndicate:tutor`

- memory: `internal-only`
- orchestrator: **Tutor** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
