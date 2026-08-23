---
type: syndicate
title: Ymir Judge
description: The Ymir Judge syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-23
sources:
  - resource: config/agents/ymir_judge.yaml
---

# Ymir Judge

<!-- wiki:fill slot="charter" -->
_TODO(fill): why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction_
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/ymir_judge.yaml" -->
- memory: `session-only`
- orchestrator: **QualityJudge** (`claude-sonnet-4-6`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
<!-- /wiki:generated -->
