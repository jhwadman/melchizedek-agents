---
type: syndicate
title: Agora Council
description: The Agora Council syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-27
sources:
  - resource: config/agents/agora.yaml
---

# Agora Council

<!-- wiki:fill slot="charter" -->
The Agora Council serves as a keyless multi-agent specimen for basic orchestration on local open-weights models (`ollama/qwen3:8b`). It stress-tests claims, plans, and decisions by pairing specialized subagents with a central orchestrator. When evaluating a proposal, the Moderator consults an Advocate for the strongest honest supporting arguments and a Skeptic for the most critical objections. It then delivers a structured verdict balancing the case for, the case against, and a final judgment. Run `npm run syndicate:agora` when you need to stress-test a decision locally without requiring external tools, API keys, or database persistence.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/agora.yaml" -->
Run: `npm run syndicate:agora`

- memory: `internal-only`
- orchestrator: **Moderator** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Advocate | `ollama/qwen3:8b` | — | — |
| Skeptic | `ollama/qwen3:8b` | — | — |
<!-- /wiki:generated -->
