---
type: tool
title: Clinical-evidence tools
description: "Read-only clinical-evidence tool contracts: literature, preprints, the trial registry, citations and corrections."
tags:
  - tools
  - science
generated:
  by: process:wiki-build
  at: 2026-09-09
sources:
  - resource: lib/tools/scienceTools.ts
---

# Clinical-evidence tools

<!-- wiki:generated section="contracts" source="lib/tools/scienceTools.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `search_literature` | `query`, `sort_by?`, `since_year?`, `limit?` | Search PEER-REVIEWED literature (PubMed and PubMed Central) through Europe PMC. |
| `search_preprints` | `query`, `sort_by?`, `since_year?`, `limit?` | Search PREPRINT servers (bioRxiv, medRxiv and the rest of Europe PMC's preprint index). |
| `search_trials` | `query`, `status?`, `phase?`, `sort_by?`, `limit?` | Search the ClinicalTrials.gov registry. |
| `resolve_identifier` | `id` | Resolve ONE identifier to its record: an NCT number, a DOI, a PMID or a PMCID. |
| `cited_by` | `doi`, `limit?` | What has cited a paper, most cited first, through OpenAlex. |
| `survey_field` | `query`, `since_year?`, `limit?` | How much has been published on a subject and the most cited of it, through OpenAlex. |
| `check_retraction` | `doi` | Ask Crossref and OpenAlex whether a DOI has been retracted, withdrawn, or had an expression of concern issued. |
<!-- /wiki:generated -->

All seven are read-only fetches over free public APIs (Europe PMC, ClinicalTrials.gov v2, Crossref, OpenAlex); none mutates state. The channel decides the evidentiary ceiling in code, every result is a labelled text block carrying each record's identifier, ceiling and registry acronym, and the `science` guard (lib/guards/science.ts) verifies an answer against exactly that text. Served over MCP by `npm run mcp:science`.
