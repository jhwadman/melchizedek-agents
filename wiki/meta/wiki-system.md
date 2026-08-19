---
type: meta
title: How this knowledge bundle works
description: The format profile (OKF v0.2), the ownership split between machine sections and prose, the toolchain that builds, lints, navigates and gardens this bundle, and where it exports.
tags:
  - meta
  - okf
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/wiki/format.ts
  - resource: scripts/wiki_build.ts
---

# How this knowledge bundle works

This directory is an **Open Knowledge Format v0.2 bundle** ([ADR 0001](/decisions/0001-okf-profile.md)): every concept is one markdown file with YAML frontmatter; normal bundle-absolute links (`[Title](/dir/doc.md)`) form the knowledge graph; `index.md` per directory and `log.md` at the root are reserved and machine-maintained.

## The profile

- `type` is the only required key. Vocabulary: overview, subsystem, syndicate, tool, model-provider, schema, protocol, runbook, guide, decision, doctrine, reference, meta.
- Optional keys that matter: `title`, `description`, `tags`, `status` (draft|stable|deprecated), `stale_after`, `sources` (what a doc derives from), `generated {by, at}`, `verified [{by, at}]`.
- Actors: `human:<id>` | `process:<id>` | `<producer>/<model>`. Trust derives from `verified`: none → unverified; machines only → machine-confirmed; any `human:` → human-reviewed. Most of this bundle is machine-produced — treat trust tiers accordingly, and add `verified` entries as you review.
- `/private/` is the annex that never exports ([ADR 0003](/decisions/0003-path-based-visibility.md)). It keeps its own `log.md`: an entry that would NAME a private document or entity goes there, because the root log is a published file and a summary line is text like any other.

## Ownership: who writes what

Documents interleave three regions. `wiki:generated` markers hold machine-owned sections rebuilt from repo truth (`npm run wiki:build` — syndicate compositions from the YAMLs, tool tables from the contracts, DDL from db/). `wiki:fill` markers hold prose slots an LLM fills once (`wiki:build -- --fill`) and rebuilds preserve. Everything outside markers is ordinary prose, edited by whoever ([ADR 0002](/decisions/0002-zero-dep-structural-engine.md) is why rebuilds can't damage it).

## The toolchain

- `npm run wiki:build` — refresh structural docs + indexes, rebuild the entity graph, lint, census. `--fill` adds the LLM pass, `--graph` also snapshots the document graph to `outputs/wiki-graph.json`, `wiki:check` lints only (CI-friendly exit code, and the gate the export runs).
- `npm run mcp:wiki` — serves the [wiki tools](/tools/wiki-tools.md) to any MCP client on `:8933`.
- The [Scriptorium syndicate](/agents/scriptorium.md) works the bundle conversationally; [gardening](/meta/gardening.md) is the how-to.
- The [Cartographers](/agents/cartographers.md) work the [knowledge graph](/meta/knowledge-graph.md) — the second layer, where entities and typed relations sit over the same files.
- `npm run wiki:init` scaffolds a fresh bundle elsewhere (`WIKI_ROOT`) — the tooling is bundle-agnostic.

## The second layer

Documents linked to documents is one graph; it answers what to read. Over the same files the build derives a second one — entities (agents, tools, models, providers, modules, tables, environment variables) joined by typed relations — so relational questions have an answer that is not grep. Structural relations are derived every run and never authored; judgment is asserted separately, with evidence, through `wiki_relate`. The vocabulary, the two stores and the gate are described in [the knowledge graph](/meta/knowledge-graph.md), the reasoning in [ADR 0005](/decisions/0005-entity-graph-layer.md).

The public repo receives this bundle minus `/private/` via the [export pipeline](/operations/export-pipeline.md).
