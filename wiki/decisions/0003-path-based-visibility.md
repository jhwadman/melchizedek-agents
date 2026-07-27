---
type: decision
title: 'ADR 0003: Path-based visibility with a link-closure lint'
description: Public/private is a subtree property — /private/ never exports — enforced by lint (no public link into /private/, no private names in public docs) before the export scans ever run.
tags:
  - decision
  - visibility
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/wiki/lint.ts
  - resource: scripts/export-public/export.sh
---

# ADR 0003: Path-based visibility with a link-closure lint

## Context

The bundle mixes exportable framework knowledge with knowledge that must never leave this repo. The export allowlist is per-file and deliberate — but a wiki grows by gardening, and requiring an export-script edit per new public document would kill the loop. Per-document frontmatter flags (`visibility: private`) were considered and rejected: visibility becomes invisible at the link site, indexes need filtering logic, and one forgotten flag leaks a document.

## Decision

Visibility is the **path**: everything under `/private/` stays here; the [export pipeline](/operations/export-pipeline.md) copies the bundle without that subtree. Three rules make it safe:

1. **Closure (lint error):** no document outside `/private/` may link into it. The exported bundle is link-closed by construction.
2. **Vocabulary (lint error):** public documents must not mention private system names — the build passes the same forbidden patterns the export scan greps for, so the wiki fails first, with a line number.
3. **No root advertisement:** the root index does not list `/private/`; locally, `wiki_map` still shows it. The public bundle contains no evidence of what was withheld.

Indexes are regenerated per-directory from same-visibility siblings, so a public index can never enumerate private docs.

## Consequences

Gardening a public doc touches zero export machinery; gardening a private one is a normal write under `/private/`. The cost: a concept can't straddle visibility — a public doc about a partly-private subsystem states the public surface and stops, as [tool contracts](/tools/tool-contracts.md) does.
