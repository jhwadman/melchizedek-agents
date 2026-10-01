---
type: decision
title: 'ADR 0023: Each provider accepts a configured endpoint and credential source, including Vertex AI, Bedrock and Azure OpenAI'
description: Direct adapters stay canonical, but where an adapter sends its requests and how it authenticates become configuration per provider — a base URL plus a credential source (environment key, secret-manager callback, or the cloud's own credential chain) — so an enterprise reaches models through its cloud contract or internal proxy; supersedes ADR 0012 item 6.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/models/providerMap.ts
  - resource: lib/models/gptLlm.ts
  - resource: lib/models/claudeLlm.ts
  - resource: lib/doctor.ts
---

# ADR 0023: Each provider accepts a configured endpoint and credential source, including Vertex AI, Bedrock and Azure OpenAI

## Context

[ADR 0012](/decisions/0012-direct-adapters-canonical.md) item 6 declined Vertex AI, "not even as documentation". It reasoned for the starter pack's audience: a newcomer with an AI Studio key.

An enterprise is often the opposite case:

- Models may be reachable only through its cloud contract: Vertex AI with workload identity, Bedrock with IAM, Azure OpenAI with private endpoints.
- Or only through an internal proxy, for data residency, logging and procurement reasons.
- It may not be allowed to hold consumer API keys at all.

Every path assumed an API key against the vendor's public endpoint: key presence checks, the doctor, request-scoped keys, and the memory service.

## Decision

1. **Items 1 to 5 of ADR 0012 stand.** One adapter per provider is canonical, and the gateway is a fallback for absent keys.
2. **Each provider takes an endpoint configuration:**
   - a base URL;
   - a credential source: an environment key, a callback into the adopter's secret manager, or the cloud's own credential chain.

   It is supplied through the `credentials` plug point ([ADR 0017](/decisions/0017-plug-points.md)) or environment variables.
3. **Three cloud endpoints are first class:**
   - Gemini on Vertex AI;
   - Claude on Bedrock and on Vertex AI;
   - GPT on Azure OpenAI.

   Each uses the provider SDK's own client for that platform. Any OpenAI-compatible internal proxy is supported through the base URL.
4. **The doctor checks each configured endpoint** and reports per agent which capabilities that endpoint keeps or drops. Each endpoint gets its own row in the capability matrix ([ADR 0019](/decisions/0019-multi-model-parity-matrix.md)).
5. **Memory extraction and embeddings resolve credentials the same way** ([ADR 0020](/decisions/0020-memory-contract.md)), so a deployment never needs a key it did not choose.

## Alternatives considered

- **Document SDK environment overrides only.** Rejected: unchecked by the doctor, untested, and silent about which server-side tools are lost.
- **Route everything through a hosted gateway.** Rejected for the same reasons as in ADR 0012, and because enterprises often cannot send traffic to a third-party gateway.

## Consequences

- Keys in environment variables remain the default, so the starter pack is unchanged.
- Endpoint-specific feature gaps are stated in the matrix before a request is made.
