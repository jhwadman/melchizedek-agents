---
type: syndicate
title: Intake Extractor
description: The Intake Extractor syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/intake_extractor.yaml
---

# Intake Extractor

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/intake_extractor.yaml" -->
- memory: `internal-only`
- orchestrator: **Intake** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
