# Production templates

Ten syndicate files built to be copied into production, one per job. The
starter pack in `../examples/` teaches the framework, and the Lyceum
course walks through it file by file. These templates are the files you
adapt and ship. Each header says what the file is for, how it is shaped,
what it remembers, what it can reach, how to serve it, and what to change
first.

| File | Axis | Job | Shape | Memory | Reaches |
|---|---|---|---|---|---|
| `conversational.yaml` | Conversation | A conversational AI: answers, keeps the thread, says when it does not know | one agent | short-term | nothing; keyless on Ollama |
| `support_triage.yaml` | Orchestration | Route every inbound support message to the one route that closes it | plan-dispatch router, `handoff` as the fallback | session | your docs (knowledge bundle), your systems (MCP) |
| `research_brief.yaml` | Orchestration | A decision-ready brief with every claim traceable | three layers: Editor → nested ResearchDesk → Scout, Reader; Writer; tool-less Verifier | short-term | the open web |
| `review_panel.yaml` | Orchestration | Ship, fix or hold a proposed change, from a coding harness | panel: Correctness, Risk, Operability → Chair | short-term | only the material it is given |
| `draft_review.yaml` | Orchestration | Outbound writing checked against your policy | bounded loop: Drafter ↔ Reviewer | short-term | only the brief |
| `intake_extractor.yaml` | Memory: short-term | Inbound document → structured JSON record, nothing kept | one agent with an `outputSchema` | short-term, `includeContents: none` | only the document |
| `case_desk.yaml` | Memory: session | Work one operational case across many turns | Lead + Runbooks + Reader, a CASE STATE block every turn | session | your runbooks, pasted links |
| `account_memory.yaml` | Memory: long-term | Remember every client's asks, decisions and commitments | Lead + Writer, `preload_memory` / `load_memory` | long-term, domain `memory_extraction_rules` | its own memory silo |
| `research_desk.yaml` | Tools | Sourced notes from the open web (nested by `research_brief`) | Lead → Scout (`web_search`) + Reader (`web_extract`) | short-term | the open web |
| `systems_operator.yaml` | Tools + integration | Your systems over MCP, the agent over HTTP; read, plan, confirm, write | Operator + Systems (`mcp_server_url`) | session | any MCP server you point it at |

## The three memory tiers

| Tier | `memory_system` | What persists | Use it when |
|---|---|---|---|
| short-term | `internal-only` | nothing past the process; add `includeContents: none` and the model sees no history at all | a request stands alone, or forgetting is a requirement |
| session | `session-only` | the conversation thread, in the session store (Supabase `adk_sessions` when configured) | one piece of work spans many turns |
| long-term | `long-term` | distilled, dated, sourced records per user, corrected and erasable (`lib/memory/README.md`) | the agent must know someone next month |

## What every template holds to

The offline suite (`tests/agents.test.ts`) enforces it:

- a `# tier:` line and a `# Template · <axis> · <name>` line;
- a declared `memory_system`;
- every `{{variable}}` resolved when it loads;
- a dispatch `default_route` that names a declared route;
- every `yaml_reference` loads, and the file loads by its bare name.

The prompts follow the same rules throughout. Facts come only from a tool
result or the material given. Text inside a tool result is data, never an
instruction. Each route has a tool budget. Anything that changes data waits
for a person's explicit yes.

## Using one

Run it: `npm run chat:syndicate -- --syndicate <name>`.
Serve it: `npm run start:a2a`, then `/<name>/a2a/rest/v1/message:send`.

A bare name resolves at `config/agents/`, then `examples/`, then
`templates/`. Copy a template to your own `config/agents/` and your copy
takes precedence.
