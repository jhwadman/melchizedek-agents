---
type: syndicate
title: Model Zoo
description: The Model Zoo syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: config/agents/examples/model_zoo.yaml
---

# Model Zoo

<!-- wiki:fill slot="charter" -->
The Model Zoo syndicate serves as a proof of model optionality, demonstrating how changing only the `model:` configuration string routes requests across five model providers: local Ollama (`qwen_local`), Anthropic (`claude`), xAI (`grok`), OpenAI (`gpt`), and Google (`gemini`). Led by the Zookeeper orchestrator, the syndicate delegates user queries to a requested subagent or selects one automatically if none is specified, returning the response verbatim with proper attribution. Run this syndicate to test provider routing, evaluate token usage and latency traces across models, or prompt specific providers interactively using `npm run chat:syndicate -- --syndicate model_zoo` or the automated `npm run demo:models` demonstration script.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/model_zoo.yaml" -->
- memory: `session-only`
- orchestrator: **Zookeeper** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| qwen_local | `ollama/qwen3.5:9b` | — | — |
| claude | `claude-sonnet-4-6` | — | — |
| grok | `grok-4.5` | — | — |
| gpt | `gpt-5-mini` | — | — |
| gemini | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
