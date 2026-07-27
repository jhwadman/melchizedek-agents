---
type: decision
title: 'ADR 0002: Zero-dependency structural markdown engine'
description: Parse and build documents with a purpose-built ~300-line structural engine instead of the remark/unified ecosystem; edit surgically by markers, never reserialize prose.
tags:
  - decision
  - markdown
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/wiki/markdown.ts
---

# ADR 0002: Zero-dependency structural markdown engine

## Context

Building docs "structurally (AST or something programmatic)" needs parsing (frontmatter, headings, links, fences, edit markers) and generation (docs assembled from typed parts). remark/unified is the standard answer — and brings a dependency tree to a repo that has none for markdown, to answer questions the wiki never asks (inline emphasis trees, HTML blocks). It also invites the classic trap: parse → mutate AST → reserialize, which reflows prose the machine doesn't own.

## Decision

`lib/wiki/markdown.ts` implements one node model both directions: a structural parser (frontmatter via the `yaml` package already in the tree, ATX headings, inline/reference links with fence and inline-code masking, `wiki:generated` / `wiki:fill` markers) and builder helpers that emit canonical markdown. Edits are **surgical splices by marker line-range** — machine-owned regions are rewritten from spec; everything outside markers is never touched, so a rebuild cannot reflow or lose prose. Full-document reserialization does not exist on the edit path.

## Consequences

Zero new dependencies in either repo ([the tool exports publicly](/operations/export-pipeline.md)). The engine answers exactly the wiki's questions and nothing else; anything needing true CommonMark semantics later can be added behind the same node model. The refresh contract ([builder](/tools/wiki-tools.md)) — generated sections always current, filled slots always preserved, `generated.at` bumped only on real change — is what makes `wiki:build` safe to run at any time.
