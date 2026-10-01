---
type: syndicate
title: Support Triage
description: The Support Triage syndicate.
tags:
  - syndicate
generated:
  by: process:wiki-build
  at: 2026-09-27
sources:
  - resource: config/agents/templates/support_triage.yaml
---

# Support Triage

<!-- wiki:fill slot="charter" -->
Support Triage is the front door of a support queue. Each inbound message (a ticket, a chat, an email body) is classified once and handled by the one route that can close it. Its shape is plan-dispatch (`lib/dispatch.ts`): the Triage classifier emits a JSON object with `route`, `reason` and `goal`, code runs that route, and the route's output is the reply. The route choice is a value in code, so it is logged, traced and streamed to the customer as a status line built from `reason`.

There are three routes. `answer` replies from your documentation with `wiki_search`, `wiki_read` and `wiki_links` over the bundle at `WIKI_ROOT` (`./wiki` when unset). `account` looks up or changes the customer's own records through the tools your MCP server publishes at `systems_mcp_url`; it proposes any change the customer did not ask for in words and makes it only after their yes. `handoff` writes a sentence for the customer, a line holding only `---`, and a structured note for the team (CASE, ASKED, KNOWN, MISSING, SIGNALS). Your integration splits the two parts. `handoff` is the `default_route`, so a failed classification still reaches a person, and a `route_overrides` pattern sends "talk to a person" and legal phrases there without a classifier call. Only `handoff` reaches a person; the other two routes end with a fixed ESCALATION line that asks the customer to reply "talk to a person".

Memory is `session-only`. The classifier sees a digest of recent turns (`lib/session/transcript.ts`), so a bare "yes" to a pending account proposal returns to `account`. Serve it with `npm run start:a2a` at `/support_triage/a2a/rest/v1/message:send`. Set `product_name` and adjust `house_voice` first.
<!-- /wiki:fill -->

<!-- wiki:generated section="composition" source="config/agents/templates/support_triage.yaml" -->
- memory: `session-only` · max_steps: 12
- orchestrator: **Triage** (`gemini-3.1-flash-lite`)

| Subagent | Model | Tools | MCP |
|---|---|---|---|
| answer | `gemini-3.1-flash-lite` | `wiki_search`, `wiki_read`, `wiki_links` | — |
| account | `gemini-3.8-flash` | — | `mcp_server_url` |
| handoff | `gemini-3.1-flash-lite` | — | — |
<!-- /wiki:generated -->
