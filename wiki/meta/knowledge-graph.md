---
type: meta
title: The knowledge graph
description: "The second layer of this bundle: entities and typed relations derived from repo truth, plus the judgments asserted over them with evidence."
tags:
  - meta
  - graph
generated:
  by: process:wiki-build
  at: 2026-08-20
sources:
  - resource: lib/wiki/entities.ts
  - resource: lib/wiki/extract.ts
  - resource: scripts/wiki/build.ts
---

# The knowledge graph

Documents linked to documents answer *what should I read next*. They cannot answer *which syndicates call `web_search`*, *what stops working without `XAI_API_KEY`*, or *how the export pipeline connects to the memory schema* — because agents, tools, keys and tables are not documents. So the bundle carries a second layer over the same files: **entities**, joined by **typed relations**.

Two tiers, never mixed ([ADR 0005](/decisions/0005-entity-graph-layer.md)):

- **extracted** — a parser read it out of a YAML, a tool contract, DDL, an import statement, a markdown link. Rebuilt from scratch by `npm run wiki:build` on every run and thrown away; it cannot drift, because nothing preserves it.
- **inferred** — a person or an agent read prose and asserted it, with the sentence that justifies it and an actor id. The build never touches these; they live beside the snapshot and are read live.

<!-- wiki:generated section="node-kinds" source="lib/wiki/entities.ts" -->
## What the graph knows about

| Kind | Id form | Now | What it is |
|---|---|---|---|
| `agent` | `agent:<name>` | 61 | one orchestrator or subagent inside a syndicate |
| `module` | `module:<name>` | 57 | one source module |
| `doc` | `/dir/doc.md` | 49 | a concept document in the bundle — identity is its bundle path |
| `file` | `file:<name>` | 34 | a repo file that is not a source module (DDL, config, prose) |
| `script` | `script:<name>` | 32 | an npm script entrypoint |
| `env` | `env:<name>` | 30 | an environment variable the code reads |
| `tool` | `tool:<name>` | 27 | a tool an agent may declare by name |
| `syndicate` | `syndicate:<name>` | 22 | one agent-team definition (a YAML) |
| `model` | `model:<name>` | 8 | a model id exactly as written in configuration |
| `provider` | `provider:<name>` | 5 | a provider adapter the model registry routes to |
| `mcp-server` | `mcp-server:<name>` | 4 | a remote MCP endpoint an agent dials at runtime |
| `table` | `table:<name>` | 4 | a database table |
| `external` | `external:<name>` | 2 | a resource outside the repo, named by URL |

A document keeps its OKF identity — the bundle path — so the two namespaces cannot collide.
<!-- /wiki:generated -->

<!-- wiki:generated section="relations" source="lib/wiki/entities.ts" -->
## The relation vocabulary

| Relation | Tier | Reads as | Now | Meaning |
|---|---|---|---|---|
| `imports` | extracted | A imports B | 156 | a static import edge between source files |
| `links_to` | extracted | A links to B | 108 | a resolved markdown link between documents |
| `uses_tool` | extracted | A calls B | 74 | the agent declares this tool by name |
| `derives_from` | extracted | A derives from B | 66 | declared in the document’s `sources:` frontmatter |
| `contains` | extracted | A contains B | 61 | the first is composed of the second |
| `uses_model` | extracted | A runs on B | 61 | the agent is configured with this model id |
| `requires_env` | extracted | A requires B | 55 | this environment variable must be set for the node to work |
| `runs` | extracted | A runs B | 47 | an entrypoint — a script, a process, a dyno — executes this |
| `defined_in` | extracted | A is defined in B | 46 | where the thing is declared in source |
| `documents` | extracted | A documents B | 42 | the document derives from, and describes, this entity |
| `reads_table` | extracted | A reads or writes B | 13 | the module names this table |
| `routes_to` | extracted | A routes to B | 8 | the model id resolves to this provider adapter |
| `connects_mcp` | extracted | A dials B | 4 | the agent discovers tools from this MCP server at runtime |
| `delegates_to` | extracted | A delegates to B | 2 | the agent is a reference to another syndicate, resolved at load time |
| `references` | extracted | A points readers at B | 0 | the source names this resource for the reader to open |
| `constrains` | inferred | A constrains B | 15 | a decision or doctrine limits what the target may do |
| `explains` | inferred | A explains B | 11 | the document is where the target’s rationale is written down |
| `depends_on` | inferred | A depends on B | 7 | the first cannot do its job unless the second holds |
| `alternative_to` | inferred | A is an alternative to B | 1 | two ways of reaching the same capability |
| `mitigates` | inferred | A mitigates B | 1 | the mechanism exists to contain the named failure |
| `supersedes` | inferred | A supersedes B | 0 | replaces an earlier decision or document |
| `contradicts` | inferred | A contradicts B | 0 | two sources state incompatible things — a rot signal |
<!-- /wiki:generated -->

## Where it lives

Both stores sit in `.graph/` inside the bundle — a dot-directory, so the vault walker ignores them and no document operation can see them:

- `.graph/graph.json` — the derived snapshot: every node, every extracted relation, stamped with the build that produced it. Regenerate with `npm run wiki:build`; never edit it.
- `.graph/relations.json` — the asserted relations: `from`, `to`, `rel`, `evidence`, `by`, `at`. Written only through the gate.

The export pipeline copies markdown only, so a derived map of PRIVATE structure cannot ride along to the public mirror ([export pipeline](/operations/export-pipeline.md), [ADR 0003](/decisions/0003-path-based-visibility.md)).

## Working it

[`wiki_graph`](/tools/wiki-tools.md) is the read path: no arguments for the census, `find` to locate a node, `node` to see everything attached to one, `path_to` for the chain joining two, `kind` to list a population. It reports its own staleness — documents added since the last build are named, not hidden.

`wiki_relate` is the only write path, and it refuses more than it accepts: an extracted relation (the build owns those), a missing endpoint, a public document pointing into the private annex, a duplicate, or an assertion without evidence. Accepted edges append to `log.md` under the `relate` op with the actor who made them.

The [Cartographers](/agents/cartographers.md) do this conversationally — the Surveyor reads and proposes with quotations, the Registrar records through the gate. [Gardening](/meta/gardening.md) covers the prose side of the same discipline, and [how this bundle works](/meta/wiki-system.md) the format underneath both.
