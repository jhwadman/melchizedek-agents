---
type: decision
title: 'ADR 0011: A live syndicate may have a private copy — gitignored, registry-published, seeded from its public example'
description: The deployment's Augustin is a gitignored file published to the agent registry from the owner's machine; the starter-pack example stays public and tracked. The two start identical and may diverge; the registry, not the slug, is what serves.
tags:
  - decision
  - agents
  - operations
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-09-20
sources:
  - resource: config/agents/examples/augustin.yaml
  - resource: scripts/deploy_agent.ts
  - resource: scripts/a2a_server.ts
---

# ADR 0011: A live syndicate may have a private copy — gitignored, registry-published, seeded from its public example

## Context

Until 2026-09-20 `config/agents/augustin.yaml` (the deployment's live Augustin) and `config/agents/examples/augustin.yaml` (the starter-pack copy the curriculum studies and the public export ships) were a byte-identical pair, edited together and verified with `diff`. That rule kept one Augustin, and it meant every change to the desk that answers Discord was also a change to public teaching material — the day the X channel moved onto `x_api_search`, the public pack moved with it. The owner wants the original Augustin, on the X API tool, to stay in melchizedek-agents, and the live desk free to change privately.

## Decision

The live copy is **gitignored** (`/config/agents/augustin.yaml` in `.gitignore`, removed from tracking with the file kept on disk) and **published to the Supabase agent registry** under the bare id `augustin` with `scripts/deploy_agent.ts` run from the owner's machine (the local `.env` holds the service-role key), followed by `heroku ps:restart`. The A2A server prefers a registry row for a bare id, so the registry — not the slug — is what serves; the slug carries only the public example, which the server would fall through to if the row were ever deleted. The example stays tracked and exported. The two start identical; a change worth teaching lands in the example, a change for this desk alone stays in the private copy.

## Consequences

- `augustin` joins `financial_router` as a registry-backed id: a push deploys nothing for it. The `update-agent` skill's table names both.
- The private copy has no git history. Its header says so and names the deploy; the registry row is its only remote.
- The wiki's Augustin page is generated from whichever copy the local checkout resolves (root first), so its composition table describes the private desk on the owner's machine and the public example everywhere else. While the two agree this is invisible; when they diverge the charter text should say which is shown.
- Precedent: melch-research keeps its ask desk gitignored for the same reason — the service stays on one machine, the shape is public.
