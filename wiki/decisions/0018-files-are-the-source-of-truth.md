---
type: decision
title: 'ADR 0018: Agent files are the source of truth; the registry is opt-in, explicit, versioned and loud'
description: A bare agent id always resolves to a YAML file; the agent registry is consulted only for an explicit registry:<id> id, never as a silent fallback, and when used it keeps versions with author and config hash and is validated at publish.
tags:
  - decision
  - agents
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: lib/loadSyndicate.ts
  - resource: lib/a2a/app.ts
  - resource: scripts/a2a_server.ts
---

# ADR 0018: Agent files are the source of truth; the registry is opt-in, explicit, versioned and loud

## Context

For a bare agent id the server preferred the `adk_agent_registry` row over the YAML file. It fell back to the file on any registry error, and pinned whichever it loaded for the life of the process. Nested `yaml_reference` agents were always read from the file, per request.

The operator therefore faced several surprises:

- A pushed YAML edit to a registry-backed agent changed nothing.
- A push that also edited a nested file made one syndicate half new.
- A publish that failed validation printed success, after which the file was served.
- A database blip on first load pinned a different version on one process than on another.
- Rows were overwritten in place, with no author, history or rollback.

The public package shipped the registry preference but neither the table definition nor the publishing tool.

## Decision

1. **A bare id resolves to a file.** Files under git already have history, review and rollback.
2. **The registry is used only for an explicit `registry:<id>` id**, or for a bare id the operator lists in `A2A_REGISTRY_AGENTS`. There is no implicit precedence and no silent fallback. A missing row is a not-found error naming the id; any other registry failure is a 503.
3. **The server resolves bare ids only in the deployment's own agents directory.** The loader's fallback to the shipped `examples/` and `templates/` is a convenience for the REPL and local development. On the server it applies only to ids the operator names in `servedAgents`. Otherwise an id whose live copy is missing would be answered by a public example of the same name.
4. **When used, the registry is append-only.** Each row carries version, config hash, author and publish time, plus an active pointer. Rollback moves the pointer.
5. **Validation happens at publish** with the same schema the loader uses, and again at load.
6. **A syndicate is versioned as a unit.** Nested references from a registry-loaded syndicate resolve from the registry version that named them.
7. **The registry is a storage plug point** ([ADR 0021](/decisions/0021-postgres-first-storage.md)), off unless configured. Its table ships in the migrations, and the publishing tool ships with it.

> **Note (2026-10-01):** Items 1 to 3 and the load-time validation are implemented. Items 4, 6 and 7 are not yet: `loadSyndicateFromRegistry` reads one `yaml_content` row per id through supabase-js, with no versions, author or active pointer; nested references still load from files; the table is not in `db/migrations/` (only `db/hardening.sql` locks it down), and no publishing tool ships in this repository, see [ADR 0021](/decisions/0021-postgres-first-storage.md).

## Alternatives considered

- **The registry as the single source of truth.** Rejected for the default: it removes git review from the most security-sensitive configuration, and needs a full control plane before it is safe.
- **Keep both with implicit precedence.** Rejected: it is the cause of every surprise listed above.

## Consequences

- **A deployment that serves bare ids from the registry must act before this ships.** Either list those ids in `A2A_REGISTRY_AGENTS`, or move its clients to `registry:<id>`. Otherwise a bare id resolves to a file. For a registry-only live copy (a deployment's edited copy of a shipped example, kept only in the registry), that file is absent from the deployed tree, and without item 3 the public example of the same name would answer instead.
- Every load logs its source (file, registry version, or example), so the wrong source is visible at the first request.
- The served config hash is shown in the boot log and on the agent card, so version skew between processes is visible.
- A registry-only live copy becomes an explicit `registry:` id with version history.
