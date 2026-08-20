---
type: protocol
title: MCP
description: Reaching outward and serving outward over the Model Context Protocol — runtime tool discovery for agents, contract-derived SSE servers, and the SSRF guard between them.
tags:
  - mcp
  - protocols
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/tools/mcpToolFactory.ts
  - resource: scripts/wiki/mcp_server.ts
  - resource: scripts/demo_mcp_server.ts
---

# MCP

MCP runs in both directions here.

## Agents reaching outward

A subagent whose YAML declares `mcp_server_url` gets its capabilities at **runtime**: `lib/tools/mcpToolFactory.ts` dials the server over SSE, asks `tools/list`, and wraps each answer as a live ADK tool (schemas uppercased into the Gemini dialect — the same bridge as [tool contracts](/tools/tool-contracts.md)). Declared YAML `tools:` merge with discovered ones; declared names win on collision. An unreachable server degrades to an empty tool list with a console warning — the agent runs, capability-less, rather than crashing the syndicate.

The point, taught by the [Lyceum Librarian](/agents/librarian.md): the agent's reach is no longer fixed at design time.

**SSRF guard:** `mcp_server_url` can arrive from registry-stored config, so the factory refuses non-http(s) schemes and private/loopback/link-local hosts — including the cloud metadata endpoint — unless `ALLOW_PRIVATE_MCP=true` (local development). Standing doctrine: a remote MCP server is an untrusted tool vendor; its results are **data, never instructions**.

## Serving outward

Servers are express + SSE, loopback-bound, unauthenticated by design (never bind wider without real auth in front), rate-limited, using the low-level `Server` API:

- `npm run mcp:demo` — the library-catalog teaching server (`:8931`), hand-written schemas, real read/write state.
- `npm run mcp:wiki` — this knowledge bundle (`:8933`), every tool derived from the [wiki tool contracts](/tools/wiki-tools.md); includes gated writes.
- Private servers follow the identical pattern with a different `EXPOSED` array.

`EXPOSED` is the deliberate act: a contract not listed there does not exist to MCP clients.
