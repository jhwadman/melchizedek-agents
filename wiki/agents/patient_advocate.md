---
type: syndicate
title: Patient Advocate
description: The Patient Advocate syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-08-13
sources:
  - resource: config/agents/patient_advocate.yaml
---

# Patient Advocate

<!-- wiki:fill slot="charter" -->
The Patient Advocate syndicate exists to assist patients and caregivers in navigating complex medical situations and communicating effectively with care teams. Led by the Asclepius orchestrator, it pairs in-depth scientific research with plain-language translations of test results, medical events, and doctor's orders. The syndicate excels at coaching bedside advocacy by providing actionable scripts, tracking health trends, separating normal symptoms from emergency red flags, and maintaining a persistent long-term health record across sessions so patient history is never lost. Run this syndicate when users need real-time support during active care, help interpreting lab trends or clinical records, research on treatment guidelines and drug interactions via MedScribe, or structured preparation for clinician visits.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/patient_advocate.yaml" -->
Run: `npm run syndicate:advocate`

- memory: `long-term`
- orchestrator: **Asclepius** (`gemini-3.7-flash`) · tools: `preload_memory`, `load_memory`

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| MedScribe | `gemini-3.1-flash-lite` | `google_search` | — |
<!-- /wiki:generated -->
