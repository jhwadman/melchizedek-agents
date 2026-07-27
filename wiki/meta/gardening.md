---
type: guide
title: Gardening this bundle
description: How to add or revise knowledge — where a document goes, what its frontmatter says, how the save gate judges it, and when to reach for wiki_garden instead of writing by hand.
tags:
  - meta
  - guide
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/tools/wikiTools.ts
---

# Gardening this bundle

Karpathy's observation, which this system exists to exploit: the tedious part of a knowledge base is not the reading or the thinking — it's the bookkeeping. Here the bookkeeping is mechanical (indexes, log, link integrity, conformance), so gardening is only the thinking part.

## Before planting

Search first — `wiki_search`, then `wiki_read` the near-misses. Revising an existing concept beats planting a duplicate; the graph rots fastest through parallel half-truths. If the knowledge is structural (a new syndicate, tool, schema change), don't write it at all: it belongs in repo truth, and `npm run wiki:build` derives the document.

## Planting

Placement: overviews in `/overview/`, per-system docs in their subsystem directory, procedures in `/operations/`, judgments as ADRs in `/decisions/` (next number, `status: stable`, supersede by adding a new ADR — never rewrite history), never-exported knowledge under `/private/`.

A concept document is: frontmatter (`type` from the [profile vocabulary](/meta/wiki-system.md), `title`, `description`, `tags`, `sources` naming what it derives from), an H1, short sections, and **generous bundle-absolute links to documents you confirmed exist** — an unlinked doc is flagged as an orphan.

## The gate

Every write goes through `wiki_save` (directly, over MCP, or via an agent). It rejects on lint errors — missing/invalid frontmatter, wikilink syntax, links escaping the bundle, public→`/private/` links — and reports advisories (broken links, orphaning) it will accept. On success it refreshes the directory index and appends to `/log.md` with your actor id (`human:jimmy`, or `<producer>/<model>` for agents). Indexes and `log.md` are never written by hand.

## Delegating

`wiki_query` answers questions with citations; `wiki_garden` takes an instruction ("record the decision we just made: …"), reads context, drafts, and saves through the same gate — the [Scriptorium](/agents/scriptorium.md) does both conversationally. Trust stays honest either way: agent writes carry the agent actor, and only a human `verified` entry upgrades a doc to human-reviewed.
