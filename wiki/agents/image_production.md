---
type: syndicate
title: Multi-Modal Image Production Workflow
description: The Multi-Modal Image Production Workflow syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-27
sources:
  - resource: config/agents/image_production.yaml
---

# Multi-Modal Image Production Workflow

<!-- wiki:fill slot="charter" -->
The Multi-Modal Image Production Workflow translates user concepts into comprehensive, structured JSON payloads to execute precise, high-fidelity image generation and specification auditing. It excels at enforcing strict multi-phase workflows that separate design, generation, perception, and review to eliminate expectation bias. During design phases, it formulates deep visual and technical specifications for user confirmation before invoking image generation tools. Upon explicit approval, it generates the artwork, and upon request, performs a blind visual inventory paired with a text-only auditor to evaluate conformance against the original payload. Run this syndicate when creating complex images requiring user-approved prompts, iterating on visual designs, or auditing generated images against detailed specifications.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/image_production.yaml" -->
Run: `npm run syndicate:image`

- memory: `session-only`
- orchestrator: **ImageDesigner** (`gemini-3.6-flash`) · tools: `generate_image`, `inspect_image`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| SpecAuditor | `gemini-3.6-flash` | — | — |
<!-- /wiki:generated -->
