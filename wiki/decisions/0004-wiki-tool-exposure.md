---
type: decision
title: 'ADR 0004: Wiki tool exposure tiers'
description: Navigation primitives and the gated save go to syndicate agents; the agentic composites (query, garden) are MCP-only; every write passes one validated gate.
tags:
  - decision
  - tools
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/tools/wikiTools.ts
---

# ADR 0004: Wiki tool exposure tiers

## Context

The wiki needs to serve two consumer shapes: syndicate agents (which ARE models, and should navigate/write directly) and outside MCP clients like a coding agent (which want high-level verbs — "answer this", "garden this" — as single calls). Handing every tool to everyone invites two failure modes: agents nesting agent-runs inside tool calls (cost and latency with no benefit), and ungated writes corrupting the bundle.

## Decision

Three tiers in [the contracts](/tools/wiki-tools.md), two exposure surfaces:

- **Navigate** (`wiki_map/read/search/links/dive`) — pure, instant, model-free. Registered for YAML declaration AND served over MCP.
- **Write** (`wiki_save`) — the only write path: parse → profile validation → lint with errors blocking (including the [closure rules](/decisions/0003-path-based-visibility.md)) → path-jailed write → index refresh → log entry. Registered for agents and served over MCP.
- **Agentic** (`wiki_query`, `wiki_garden`) — one-shot agents equipped with the tiers above, honest actor attribution in provenance. **MCP-only**: a syndicate reaches this behavior by being an agent WITH the primitives ([the Scriptorium](/agents/scriptorium.md)), never by nesting.

## Consequences

An MCP client gets the wiki as three verbs deep and eight tools wide; a syndicate gets exactly the primitives. The worst an agent can do through the gate is write mediocre prose — structure, conformance, and closure are enforced, log.md records the act, and git reverts it. Read-only deployments serve the agent-tier list instead.
