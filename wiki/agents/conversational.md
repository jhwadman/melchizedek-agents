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
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/conversational.yaml" -->
Run: `npm run syndicate:conversational`

- memory: `internal-only`
- orchestrator: **Conversational** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
