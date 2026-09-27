---
type: decision
title: 'ADR 0016: Production templates live in their own directory beside the starter pack, not as rewrites of it'
description: Ten job-shaped syndicates built to be adapted and shipped go in config/agents/templates/, held to a contract the teaching examples are not held to, rather than upgrading the starter-pack files in place — because the course teaches those files line by line.
tags:
  - decision
  - starter-pack
  - templates
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-09-27
sources:
  - resource: config/agents/templates/README.md
  - resource: lib/loadSyndicate.ts
  - resource: tests/agents.test.ts
---

# ADR 0016: Production templates live in their own directory beside the starter pack, not as rewrites of it

## Context

The owner's direction for melch.ai is to help people build agents, prove them, and then integrate them into their work. That needs templates a company would actually ship, organised by what people build: orchestration patterns, the three memory tiers, tools, and HTTP plus MCP. The starter pack has most of the patterns, but they are named for the pattern (`delegation`, `hierarchical`, `critic`), and several carry toy prompts. Those files are also course material. Lyceum's modules and downloads walk through `critic`, `council`, `style_council`, `image_production`, `augustin` and `tutor` line by line.

Two shapes were considered. The first was to upgrade the starter-pack files in place. The second was to add a separate set of job-shaped templates beside them.

## Decision

A separate set, in `config/agents/templates/`: `conversational`, `support_triage`, `research_brief` (which nests `research_desk`), `review_panel`, `draft_review`, `intake_extractor`, `case_desk`, `account_memory` and `systems_operator`. Each one names its job, shape, memory tier, reach, how to serve it, and what to change first. They use public tools only and ship in the package and the mirror.

Rewriting the examples would have broken the course, which quotes them, and would have made one file do two jobs: teach a mechanism in its smallest form, and serve as a production starting point. Those two pull in opposite directions.

The loader resolves a bare name at the root, then `examples/`, then `templates/`, still inside the jail. So an A2A route (one path segment) and a nested `yaml_reference` reach a template without a path. `npm run doctor` lists the directory.

## Consequences

- The templates carry a contract the examples do not, enforced offline in `tests/agents.test.ts`:
  - a `# tier:` line and a `# Template · <axis> · <name>` line;
  - a declared `memory_system`;
  - no unresolved `{{variable}}`;
  - a dispatch `default_route` that names a route;
  - every nested file loads, and the file loads by its bare name.
- Names must stay unique across the root, `examples/` and `templates/`, because the first match wins. A user's own copy at the root takes precedence on purpose.
- Variables do not nest (interpolation is one pass), so a shared prompt block cannot hold a `{{token}}`. The support template names its product in each route's own instruction instead.
- Building the templates exposed two defects, both fixed in the same change:
  - `web_extract` cited the URL it was asked for, not the one a redirect landed on. Research notes built on search results cited opaque grounding links; a `Resolved:` line now names the publisher.
  - The public test suite's compile tier walked only the root, so in the package it compiled the schema file alone.
- Every template was run live once against a realistic case before it shipped. Those runs are not published as evals.
