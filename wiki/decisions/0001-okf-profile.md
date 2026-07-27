---
type: decision
title: 'ADR 0001: Adopt OKF v0.2 as the bundle format'
description: The knowledge vault is an Open Knowledge Format bundle — markdown + YAML frontmatter + normal links — under a small local profile, rather than a bespoke wiki format.
tags:
  - decision
  - okf
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: https://github.com/GoogleCloudPlatform/knowledge-catalog
    title: OKF v0.2 specification
  - resource: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
    title: Karpathy's LLM-wiki pattern
---

# ADR 0001: Adopt OKF v0.2 as the bundle format

## Context

The vault needed a document format an LLM can produce and maintain (Karpathy's LLM-wiki pattern: index, log, ingest/query/lint) that other systems can consume without our tooling. Inventing a format would orphan the content; adopting a heavy one would contradict the repo's zero-ceremony doctrine.

## Decision

The bundle conforms to **OKF v0.2**: every concept is a markdown file whose YAML frontmatter needs only `type`; `index.md`/`log.md` are reserved; links are normal markdown links, bundle-absolute preferred, and the links ARE the graph. On top, a thin local profile ([meta](/meta/wiki-system.md)): a recommended type vocabulary, the v0.2 trust family (`generated`, `verified`, `sources`, `status`, `stale_after`), and the actor convention — only `human:` verification yields the human-reviewed trust tier.

Two Karpathy conventions the spec leaves optional are mandatory here: a machine-parseable `log.md` (newest first) and per-directory indexes, both machine-maintained.

## Consequences

Any OKF consumer can read the bundle cold — it renders on GitHub, greps, and diffs. Conformance is enforced by our own [lint](/tools/wiki-tools.md) at write time rather than trusted to habit. Standard links (not `[[wikilinks]]`) mean plain markdown tooling never sees broken syntax; lint rejects wikilink syntax outright. The trust tiers make LLM-authored prose visibly distinct from human-reviewed doctrine — which this bundle, largely machine-produced, needs.
