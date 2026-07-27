---
type: model-provider
title: Provider routing
description: "How a model string in YAML reaches the right provider adapter: one prefix table, five providers, availability by API key."
tags:
  - models
  - routing
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-26
sources:
  - resource: lib/models/providerMap.ts
  - resource: lib/models/registry.ts
---

# Provider routing

<!-- wiki:fill slot="overview" -->
Model string routing relies on a single prefix table in `lib/models/providerMap.ts` across two distinct resolution paths. Standard entrypoints passing model names as strings rely on `registerAvailableProviders()`, which registers adapter classes into the ADK `LLMRegistry` to match string patterns such as `claude-*`, `gpt-*`, or `ollama/<model>`. In contrast, per-request paths like the [A2A server](/protocols/a2a.md) use `resolveModel()`, an instance factory that injects custom header credentials directly into new adapter instances.

All provider registration must occur before constructing agents. The `LLMRegistry` maintains an internal cache for model-to-class resolutions, meaning late registration can lead to stale cache hits that fail to resolve newly available providers.
<!-- /wiki:fill -->

<!-- wiki:generated section="providers" source="lib/models/providerMap.ts" -->
| Provider | Label | Key env | Model prefix | Default |
|---|---|---|---|---|
| gemini | Google Gemini | `GOOGLE_GENAI_API_KEY` | `gemini-*` | `gemini-3.1-flash-lite` |
| anthropic | Anthropic Claude | `ANTHROPIC_API_KEY` | `claude-*` | `claude-sonnet-4-6` |
| openai | OpenAI GPT | `OPENAI_API_KEY` | `gpt-*`, `o<digit>*` | `gpt-5-mini` |
| xai | xAI Grok | `XAI_API_KEY` | `grok-*` | `grok-4-1-fast-reasoning` |
| ollama | Ollama (local) | (keyless, local) | `ollama/<model>` | `ollama/qwen3:8b` |
<!-- /wiki:generated -->

Wiki agent operations default to `gemini-3.6-flash` (WIKI_AGENT_MODEL in lib/config.ts). Schema-dialect bridging between Gemini-uppercase and standard JSON Schema is covered in [tool contracts](/tools/tool-contracts.md).
