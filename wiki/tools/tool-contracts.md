---
type: subsystem
title: Tool contracts
description: Define a tool once — name, description, zod schema, execute — and derive every serving surface from it; exposure remains a separate, deliberate act.
tags:
  - tools
  - contracts
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: lib/tools/toolContract.ts
  - resource: lib/models/schemaNormalize.ts
---

# Tool contracts

A native tool that should reach both our own agents (ADK `FunctionTool`, Gemini-dialect schema) and outside MCP clients (standard JSON Schema) used to need its schema written twice — two dialects of one contract, guaranteed to drift. `lib/tools/toolContract.ts` collapses that: a tool is **one object** — `{ name, description, schema (zod), execute }` — and thin adapters derive each surface:

- `toFunctionTool()` → live ADK tool for syndicate agents.
- `toMcpToolDefinition()` → `tools/list` entry for MCP servers.

`executeContract()` validates arguments against the zod schema and returns an **error string on failure, never a throw** — the calling model sees what to fix and retries.

## The dialect bridge

zod v4's native `z.toJSONSchema()` emits standard JSON Schema — what MCP and four of the five providers natively want. `toGeminiSchema()` derives the ADK dialect from it (types UPPERCASED, `additionalProperties`/`default` dropped); `lib/models/schemaNormalize.ts` is the exact inverse, lowercasing FunctionTool schemas back at request-build time for the non-Gemini providers in [provider routing](/models/provider-routing.md). One schema, both dialects, round-trip tested.

## Exposure is deliberate

Defining a contract publishes nothing. An agent sees a tool only when its name is in `lib/toolRegistry.ts` **and** declared in the syndicate YAML; an MCP client sees it only when a server script lists it in `EXPOSED` (see [MCP](/protocols/mcp.md)). Every widening of the surface is a diff someone chose.

The [wiki tools](/tools/wiki-tools.md) and the [web tools](/tools/web-tools.md)' `web_extract` are contracts under this pattern; the private market-data tools follow the identical shape and stay unexported.
