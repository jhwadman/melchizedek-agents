---
type: decision
title: 'ADR 0006: The starter pack is not the product'
description: Split config/agents/ into a root for the deployment's live syndicates and an examples/ subdirectory for the shipped teaching syndicates, with loader fallback — rather than extracting the engine into a package.
tags:
  - decision
  - agents
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-19
sources:
  - resource: lib/loadSyndicate.ts
  - resource: config/agents/README.md
---

# ADR 0006: The starter pack is not the product

## Context

Downstream users authoring their own syndicates reported the same confusion: the repo ships with syndicates, so where does *theirs* fit? Everything a newcomer touched presented the shipped examples and the engine as one product — one flat `config/agents/` directory holding teaching specimens, production configuration, and the authoring schema side by side, with the loader path-jailed to that single directory so a user's syndicate was forced to live among the examples as an apparent seventeenth specimen.

The engine was never actually coupled to the examples — nothing in `lib/` names a syndicate — but the layout said otherwise.

## Decision

The directory states the boundary the code already had. The root of `config/agents/` holds the deployment's live syndicates (the financial family, the arbiter) and the authoring schema; `config/agents/examples/` holds the fifteen shipped teaching syndicates, framed everywhere as a **starter pack** — copy it, gut it, delete it.

`lib/loadSyndicate.ts` resolves a bare filename against the root first, then `examples/`, both inside the existing jail. Every caller — npm scripts, A2A bare-id fallback, nested `yaml_reference` — is therefore indifferent to which side of the split a file is on, and promoting an example to production is a one-level move. Misclassification degrades gracefully instead of breaking a route.

Extracting the engine into an npm package was considered and deferred: it is the fuller answer to "my syndicate should live in my repo" (one sibling repo already consumes `lib/` directly by relative import), but it buys versioning and publishing obligations the split does not, and the split alone dissolves the reported confusion.

## Consequences

The public mirror and the curriculum inherit the layout: the export allowlist names `examples/` paths, lessons and downloads point at the starter pack, and a `config/agents/README.md` states the contract in place. Consumers that reach the framework through its real interfaces — the A2A surface, `lib/` imports — were unaffected, which is itself the argument that the boundary was already sound and only unstated.
