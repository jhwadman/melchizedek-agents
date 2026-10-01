---
type: syndicate
title: Lyceum Librarian
description: The Lyceum Librarian syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-10-01
sources:
  - resource: config/agents/examples/librarian.yaml
---

# Lyceum Librarian

<!-- wiki:fill slot="charter" -->
The Lyceum Librarian syndicate serves as the Model Context Protocol ([MCP](/protocols/mcp.md)) specimen for dynamic runtime tool discovery. It exists to demonstrate how an agent reaches outward to inspect and modify external data without declaring fixed tools at design time. The orchestrating Archivist manages patron requests, while the Librarian subagent connects to an MCP server at runtime to discover tools for searching, reading, borrowing, and annotating scrolls.

This syndicate excels at querying catalog availability and performing remote state changes while enforcing strict subagent delegation. Run this syndicate when demonstrating dynamic tool discovery over [MCP](/protocols/mcp.md) or when handling patron interactions that query, borrow, or annotate library catalog records. Start the demo catalog with `npm run mcp:demo` (port 8931), set `ALLOW_PRIVATE_MCP=true` so the loopback address is allowed, then run `npm run syndicate:librarian`. Writes happen in the turn the patron asks; [Systems Operator](/agents/systems_operator.md) is the production shape, where a change waits for an explicit yes.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/examples/librarian.yaml" -->
Run: `npm run syndicate:librarian`

- memory: `internal-only`
- orchestrator: **Archivist** (`gemini-3.8-flash`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| Librarian | `gemini-3.1-flash-lite` | — | `mcp_server_url` |
<!-- /wiki:generated -->
