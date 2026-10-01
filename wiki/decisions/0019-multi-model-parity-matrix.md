---
type: decision
title: 'ADR 0019: "Multi-model" means orchestration parity, stated as a tested capability matrix'
description: Any provider may run any role, including an orchestrator that delegates; what each provider keeps and loses is data in the capability module, printed by the doctor, checked by the compiler and backed by one offline request-shape test per cell.
tags:
  - decision
  - models
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/models/capabilities.ts
  - resource: lib/doctor.ts
  - resource: lib/models/gptLlm.ts
---

# ADR 0019: "Multi-model" means orchestration parity, stated as a tested capability matrix

## Context

The documentation promised that any agent in a graph can run on any provider. Leaf agents could, and their request shaping was well tested.

Orchestrators on Claude, GPT, Grok, Ollama or the gateway could not delegate reliably. The adapters built tool declarations from `FunctionTool`'s private `parameters` field. `AgentTool` and the built-in memory tools have no such field, so the model was told the sub-agent takes no arguments. The one GPT orchestrator in production was moved back to Gemini instead.

The capability module modelled only the four server-side search tools and called everything else "portable". The doctor therefore reported such configurations as ready.

## Decision

1. **The promise is parity.** Any provider may run any role, orchestrators included.
2. **Adapters build declarations from the tool's own declaration** (`_getDeclaration()` or the request's function declarations), never from private fields.
3. **`lib/models/capabilities.ts` becomes a matrix** of provider × capability:
   - delegation;
   - memory tools;
   - structured output;
   - thinking with tool use;
   - streaming;
   - native search;
   - vision.

   Each cell is supported, degraded with a named loss, or unsupported.
4. **Every cell is backed by an offline request-shape test per adapter.** These run against real ADK tool objects, not mocks shaped like the private field.
5. **The doctor prints the matrix and the documentation table is generated from it.** The compiler warns when a role needs a capability its model lacks.

## Alternatives considered

- **Promise "Gemini orchestrators, any-provider leaves".** Honest but narrower. It was rejected because the defect was in the repo's adapters and is fixable, not in the providers.

## Consequences

- A capability that cannot reach parity on a provider, such as thinking with tool use on Claude, is stated in the matrix rather than discovered in production.
- Adding a provider or an endpoint ([ADR 0023](/decisions/0023-bring-your-own-endpoint.md)) means filling its row before it is called supported.
