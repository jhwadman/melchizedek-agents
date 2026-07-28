---
type: syndicate
title: Council
description: The Council syndicate.
tags:
  - syndicate
generated:
  by: melchizedek/gemini-3.6-flash
  at: 2026-07-28
sources:
  - resource: config/agents/council.yaml
---

# Council

<!-- wiki:fill slot="charter" -->
The Council exists as a local multi-agent specimen that runs entirely on open-weights models (`ollama/qwen3:8b`) without requiring API keys, tools, or a database. It stress-tests claims, plans, and decisions by gathering independent perspectives before reaching a conclusion.

Run the Council when evaluating a proposed claim or decision. The Moderator delegates the user's proposal verbatim to the Advocate to build the strongest honest case for it, and then to the Skeptic to identify risks and failure modes. Once both subagents report, the Moderator weighs both perspectives to output a structured report detailing the case for, the case against, and a final verdict.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/council.yaml" -->
Run: `npm run syndicate:council`

- memory: `internal-only`
- orchestrator: **Moderator** (`ollama/qwen3:8b`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Advocate | `ollama/qwen3:8b` | — | — |
| Skeptic | `ollama/qwen3:8b` | — | — |
<!-- /wiki:generated -->
