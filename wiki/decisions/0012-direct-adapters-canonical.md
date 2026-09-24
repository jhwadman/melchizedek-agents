---
type: decision
title: 'ADR 0012: Direct adapters are canonical; a gateway is a fallback that fills only the keys that are absent'
description: Keep one adapter per provider as the way models are served, generate the "which keys do I need" answer from the YAMLs with a doctor, and offer a hosted gateway only as an opt-in stand-in for ids whose direct key is missing — never as a mode that overrides a present key, never through Vertex AI, and never selectable from an A2A request.
tags:
  - decision
  - models
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-09-23
sources:
  - resource: lib/models/gateway.ts
  - resource: lib/models/gatewayLlm.ts
  - resource: lib/models/capabilities.ts
  - resource: lib/doctor.ts
  - resource: plans/model-access-tiers.md
---

# ADR 0012: Direct adapters are canonical; a gateway is a fallback that fills only the keys that are absent

## Context

The framework routes a model id to one of five adapters by prefix, and each cloud adapter needs its own key. The owner asked whether one platform credential — Vertex AI, or a hosted gateway — could replace the four, so a newcomer never collects a key per provider. Two facts framed the answer. Much of what the agents declare exists on one provider only: Gemini grounding, Anthropic's server-side `web_search`, xAI's `x_search` and Collections, the Grok effort pin. And the problem is smaller than it looks: twelve of the sixteen starter-pack examples run on the Gemini key alone, two need no key, and only two touch another provider by design.

## Decision

1. **Direct adapters stay canonical.** A model id whose provider key is present is always served by that provider's own adapter. Nothing routes around a present key.
2. **The answer to "which keys" is generated, not written.** `lib/doctor.ts` (`npm run doctor`, the `melchizedek-doctor` bin) reads every syndicate the loader can see, resolves each model under the current environment through the same modules the registry uses, and prints per agent what is funded, what is dropped, and which variable unlocks what. It is read-only and prints no key value. Each starter-pack file carries a `# tier:` header the doctor checks against the models.
3. **Capability loss is stated before a request, per agent, on the resolved path.** `lib/models/capabilities.ts` names which declared server-side sentinels a path keeps and drops; the compiler logs it once per affected agent, the chat-completions base records `llm.transport` and `llm.capability.dropped` on the span, and the doctor shows it.
4. **A gateway is a fallback.** With `MODEL_GATEWAY` and `MODEL_GATEWAY_API_KEY` set, an id whose direct key is *absent* is served by `GatewayLlm` through the gateway's OpenAI-compatible chat-completions endpoint. Ollama never is. Adding a direct key beside the gateway key upgrades that provider back to native fidelity with no YAML change. The gateway is not a provider in `providerMap.ts` and does not change `llm.provider`; it is a transport.
5. **The gateway key is server environment only.** An A2A caller's `X-API-Key` funds that caller's declared provider directly and never selects the gateway. The exposed surface does not widen.
6. **Vertex AI is not offered**, not even as documentation. It cannot carry OpenAI's hosted models, so it can never be the one-key answer, and its service-account credential is heavier than a gateway key for the audience the starter pack serves.

## Alternatives considered

- *Gateway as a mode that routes everything.* Simpler to explain, but a present Google key would then be useless and twelve examples would lose grounding for no reason. Rejected: the curriculum's point is that model choice is a routing and cost decision with real trade-offs.
- *A gateway prefix in `providerMap.ts`.* Would change what the ledger records as the provider and leak into the generated provider table. Rejected; the registry owns the transport decision and the map stays a leaf.
- *Vertex AI adapters for Claude and Grok.* Three of four providers, a new secret class on Heroku, and still not one key. Rejected.
- *Asking every newcomer for four keys up front.* Rejected; the doctor lets a key arrive when an agent demands one, which is how this deployment grew.
- *Subclassing `GptLlm` for the gateway.* It speaks OpenAI's Responses API; gateways universally speak chat completions, the dialect the Ollama adapter already exercises. The gateway subclasses that base.

## Consequences

- One gateway key runs every starter-pack example; the doctor's gateway verdicts say `google_search lost` or `web_search lost` where it matters.
- Through the gateway every server-side sentinel is dropped; tool calling, structured output, `reasoning_effort`, streaming and token accounting work unchanged.
- `providerStatuses()` gains `transport` and `gateway`; the registry log prints `◇ … via gateway:<id>` for covered providers and names a misconfigured gateway instead of ignoring it silently.
- The public package moves to 0.12.0: a third bin, new root exports, and the `./models/*` map publishing the three new modules.
- Wire names are mapped by rule (`anthropic/claude-sonnet-4.6`) with `MODEL_GATEWAY_MODEL_MAP` for the exceptions, so an upstream renaming is an env change, not a release.
- `plans/model-access-tiers.md` is the design record and now reads as history.
