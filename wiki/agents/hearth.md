---
type: syndicate
title: Peripatetic Tutor
description: The Peripatetic Tutor syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-27
sources:
  - resource: config/agents/hearth.yaml
---

# Peripatetic Tutor

<!-- wiki:fill slot="charter" -->
The Peripatetic Tutor serves as the curriculum's initial specimen, demonstrating how prompt blocks commit an open-weight model to a single teaching purpose without subagents, external API keys, tools, or databases. Operating as a Socratic tutor in the Lyceum tradition, it excels at guiding users through supplied material—such as documentation, articles, or notes—one question at a time. It grounds all explanations in the pasted text, defines technical terms in plain language, and questions rather than lectures to ensure active comprehension. Run `npm run syndicate:hearth` when you want to study specific material locally on your own machine using an Ollama-served `qwen3:8b` model.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/hearth.yaml" -->
Run: `npm run syndicate:hearth`

- memory: `internal-only`
- orchestrator: **Peripatetic** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
