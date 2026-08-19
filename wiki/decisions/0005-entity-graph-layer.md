---
type: decision
title: 'ADR 0005: An entity layer over the document graph'
description: Add typed entities and relations derived from repo truth as a second layer inside the bundle, with judgment asserted separately and evidenced — rather than adopting a parallel graph store.
tags:
  - decision
  - graph
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-19
sources:
  - resource: lib/wiki/entities.ts
  - resource: lib/wiki/extract.ts
---

# ADR 0005: An entity layer over the document graph

## Context

The document graph ([how this bundle works](/meta/wiki-system.md)) had 42 concepts joined by 148 links and answered reading questions well. It could not answer relational ones — which syndicates call a tool, what fails without a key, how a decision reaches the pipeline it constrains — because the subjects of those questions are agents, tools, keys and tables, not documents. Its shape made this worse: nine of twenty syndicate documents had no outbound links at all, so walking from an agent went nowhere.

The obvious move was a graph-extraction tool of the kind now common: run an LLM over the repo, emit a nodes-and-edges store, cluster it, publish a report. Adopting one as a **parallel** store was rejected on three counts. It would drift from the bundle the moment either side changed. It would sit outside the `wiki_save` gate that makes every other write safe. And it would ingest `/private/` into an artifact governed by neither the export allowlist nor the path-visibility rule ([ADR 0003](/decisions/0003-path-based-visibility.md)) — a privacy regression bought with convenience.

The other observation: most of what such a tool infers here is not inference at all. Which model an agent runs on, which tools it declares, what a module imports, which table it touches — all of it is written literally in a YAML, a contract, an import statement, DDL. A parser sees it exactly, for free, every run.

## Decision

One graph, inside the bundle, in two tiers that are labelled and never mixed.

**Extracted** relations are derived by `npm run wiki:build` from the same repo truth the documents derive from, using zero-dependency scanners ([extract](/meta/knowledge-graph.md), the judgment of [ADR 0002](/decisions/0002-zero-dep-structural-engine.md) applied again). They are rebuilt from scratch on every run and written to `.graph/graph.json`, which nothing but the build may write. Derived state cannot rot; a scanner that reads only literals cannot invent.

**Inferred** relations — the seven that require reading prose (`depends_on`, `constrains`, `supersedes`, `explains`, `alternative_to`, `mitigates`, `contradicts`) — are asserted one at a time through `wiki_relate`, each carrying its evidence and the actor who made it, into `.graph/relations.json`. The build never touches that file; the tools read it live, so an assertion is visible immediately.

The gate refuses an extracted relation asserted by hand, a missing endpoint, a self-loop, a duplicate, and a public document pointing into the private annex. Both stores live in a dot-directory the vault walker skips, so no document operation sees them and the markdown-only export cannot ship them.

## Consequences

The graph went from 42 nodes to over 300 — agents, models, providers, tools, MCP endpoints, modules, tables, environment variables, npm entrypoints — and the relational questions became one `wiki_graph` call. Its edges are honest about their provenance: extracted ones name the file they were read from, asserted ones quote the sentence.

The costs are real and accepted. The snapshot is as fresh as the last build, so `wiki_graph` reports its own staleness rather than pretending. The scanners are literal: a dynamically-built import or table name is invisible to them, which is preferable to a guess. And assertion is deliberate work — the [Cartographers](/agents/cartographers.md) exist to do it at scale, but nothing asserts itself.

The public mirror receives the engine and the tools but not `scripts/wiki_build.ts`, which is private; there, `wiki_graph` serves whatever snapshot the bundle carries and says so plainly when it carries none.
