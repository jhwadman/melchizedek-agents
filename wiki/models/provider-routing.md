---
type: model-provider
title: Provider routing
description: "How a model string in YAML reaches the right provider adapter: one prefix table, five providers, availability by API key."
tags:
  - models
  - routing
generated:
  by: process:wiki-build
  at: 2026-09-22
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
| xai | xAI Grok | `XAI_API_KEY` | `grok-*` | `grok-4.7` |
| ollama | Ollama (local) | (keyless, local) | `ollama/<model>` | `ollama/qwen3:8b` |
<!-- /wiki:generated -->

## Transport: direct by default, a gateway only for what is absent

The table above is the whole routing decision; the *transport* is a second, separate decision made in `lib/models/gateway.ts` and applied by the registry. A model id is served by its provider's own adapter whenever that provider's key is present. When the key is absent and `MODEL_GATEWAY` (`vercel` or `openrouter`) plus `MODEL_GATEWAY_API_KEY` are set, the id is served instead by `lib/models/gatewayLlm.ts` through the gateway's OpenAI-compatible chat-completions endpoint — a subclass of the same base the Ollama adapter uses. Ollama never routes through a gateway, and an [A2A](/protocols/a2a.md) caller's `X-API-Key` funds its own provider directly and never selects the gateway. The gateway is not a provider: `llm.provider` on the [ledger](/operations/observatory.md) stays `anthropic`, `openai`, `gemini` or `xai`, and the path is recorded separately as `llm.transport = gateway:<id>`.

What a gateway cannot do is enable any upstream native search, so every server-side tool sentinel — `web_search`, `google_search`, `x_search`, `collections_search` — is dropped on that path. `lib/models/capabilities.ts` states this per agent on the resolved path; the compiler logs one `capability ·` line per affected agent at startup, the span carries `llm.capability.dropped`, and the doctor below shows it. Wire names follow a rule (`claude-sonnet-4-6` → `anthropic/claude-sonnet-4.6`; `grok-4.7` → `xai/…` on Vercel, `x-ai/…` on OpenRouter) with `MODEL_GATEWAY_MODEL_MAP` for exceptions and `MODEL_GATEWAY_BASE_URL` for a self-hosted proxy. Rationale: [ADR 0012](/decisions/0012-direct-adapters-canonical.md).

## Which keys do I need? The doctor

`npm run doctor` (`lib/doctor.ts`; the `melchizedek-doctor` bin in the package) reads every syndicate the loader can see — the root and `examples/` — resolves each agent's model under the current environment through these same modules, and prints one table: agent, model, provider, the declared server-side tools the path keeps (✓) or drops (✗), and whether the path is funded (direct key, gateway, or local). One verdict per syndicate, then the variables that would unlock the most and where to get each. It is read-only and never prints a key value. Every starter-pack file opens with a `# tier:` header (`keyless`, a single provider such as `gemini`, or `multi-provider`) that the doctor checks against the models. The live counterpart that actually sends a prompt per provider is `npm run demo:models`.

Wiki agent operations default to `gemini-3.8-flash` (WIKI_AGENT_MODEL in lib/config.ts). Schema-dialect bridging between Gemini-uppercase and standard JSON Schema is covered in [tool contracts](/tools/tool-contracts.md).
