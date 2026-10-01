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

A native tool can reach two surfaces: syndicate agents (ADK `FunctionTool`, Gemini-dialect schema) and outside MCP clients (standard JSON Schema). Writing the schema once per dialect would let the two drift. In `lib/tools/toolContract.ts` a tool is **one object**, `{ name, description, schema (zod), execute }`, built with `defineTool()`, and thin adapters derive each surface:

- `toFunctionTool()` → live ADK tool for syndicate agents.
- `toMcpToolDefinition()` → `tools/list` entry for MCP servers.

`executeContract()` validates arguments against the zod schema and returns an **error string on failure, never a throw** — the calling model sees what to fix and retries.

## The dialect bridge

zod v4's native `z.toJSONSchema()` emits standard JSON Schema — what MCP and four of the five providers natively want. `toGeminiSchema()` derives the ADK dialect from it (types UPPERCASED, `additionalProperties`/`default` dropped); `lib/models/schemaNormalize.ts` reverses the case change, lowercasing FunctionTool schemas back at request-build time for the non-Gemini providers in [provider routing](/models/provider-routing.md). One schema serves both dialects; `tests/models.test.ts` covers the lowercasing.

## Exposure is deliberate

Defining a contract publishes nothing. An agent sees a tool only when its name is registered — in `lib/toolRegistry.ts`, or by a package consumer's own call to `registerTool(name, contract)` — **and** declared in the syndicate YAML; an MCP client sees it only when a server script lists it in the `contracts` it passes to `serveContracts()` (`lib/tools/mcpServe.ts`; see [MCP](/protocols/mcp.md)). Every widening of the surface is a line of code someone chose; YAML can name only what code registered, never load it. The registry is a null-prototype map, so a name like `constructor` resolves to nothing and gets the unknown-tool warning.

The [wiki tools](/tools/wiki-tools.md), the [clinical-evidence tools](/tools/evidence-tools.md), the [task tools](/tools/task-tools.md), and the [web tools](/tools/web-tools.md)' `web_extract` and `x_api_search` are contracts under this pattern.
