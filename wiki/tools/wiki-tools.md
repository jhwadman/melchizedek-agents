---
type: tool
title: Wiki tools
description: "The knowledge-bundle tool surface: navigation, gated writing, and agentic composites, defined once as zod contracts."
tags:
  - tools
  - wiki
  - mcp
generated:
  by: process:wiki-build
  at: 2026-08-19
sources:
  - resource: lib/tools/wikiTools.ts
---

# Wiki tools

<!-- wiki:fill slot="overview" -->
This document details the tool surface used by agents and external clients to interact with the knowledge bundle. Defined as Zod contracts in code, these tools span three capability tiers: read-only navigation primitives (`wiki_map`, `wiki_read`, `wiki_search`, `wiki_links`, `wiki_dive`, and `wiki_graph` over the [entity layer](/meta/knowledge-graph.md)), two gated write interfaces (`wiki_save` for documents, `wiki_relate` for asserted relations), and agentic composites (`wiki_query`, `wiki_garden`). Following the architecture outlined in [tool contracts](/tools/tool-contracts.md), a single contract definition generates tools for syndicate agents as well as [MCP](/protocols/mcp.md) servers. As specified in [ADR 0004](/decisions/0004-wiki-tool-exposure.md), this design separates tool contracts from exposure tiering, ensuring that all modifications pass through validation and linting checks before updating the [wiki system](/meta/wiki-system.md).
<!-- /wiki:fill -->

<!-- wiki:generated section="contracts" source="lib/tools/wikiTools.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `wiki_map` | — | Orient in the knowledge bundle: its purpose, directory map, document census, and graph health. |
| `wiki_read` | `path`, `section?` | Read one wiki document by bundle path (e.g. |
| `wiki_search` | `query`, `limit` | Lexical search over the knowledge bundle (titles, tags, headings, paths, body). |
| `wiki_links` | `path`, `depth`, `direction` | Walk the knowledge graph from one document: what it links to and what links to it, out to a chosen depth. |
| `wiki_dive` | `task`, `budget_words` | Repo dive: given a TASK, get an ordered reading plan through the bundle — orientation indexes first, then matched concepts, then graph-linked context, within a word budget. |
| `wiki_graph` | `node?`, `find?`, `kind?`, `path_to?`, `relations?`, `depth`, `direction`, `limit` | Query the ENTITY graph: agents, syndicates, models, providers, tools, MCP servers, modules, tables, env vars, npm scripts and documents, joined by typed relations (uses_tool, uses_model, imports, reads_table, requires_env, documents, depends_on, constrains…). |
| `wiki_save` | `path`, `content`, `actor`, `summary` | Write one concept document into the bundle (create or revise). |
| `wiki_relate` | `from`, `to`, `relation`, `evidence`, `actor`, `note?` | Assert ONE typed relation the build cannot derive — a judgment read out of prose (depends_on, constrains, supersedes, explains, alternative_to, mitigates, contradicts). |
| `wiki_query` | `question`, `model?` | Ask the knowledge bundle a question in natural language. |
| `wiki_garden` | `instruction`, `model?` | Delegate a wiki edit to a gardener agent: author a new concept document or revise existing ones from an instruction. |
<!-- /wiki:generated -->

Serving: `npm run mcp:wiki` exposes all of these over SSE at `localhost:8933/sse`. Syndicate agents declare the navigation and save tools by name in YAML — see [tool contracts](/tools/tool-contracts.md) for how one definition feeds both surfaces.
