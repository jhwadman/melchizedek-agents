# melchizedek-agents

**A multi-model, multi-agent orchestration framework built on the Google
Agent Development Kit — where the entire shape of an agent system is one
readable YAML file.**

Melchizedek runs hierarchical agent graphs called *Syndicates*: an
orchestrator, its subagents, their tools, models, and communication laws,
all declared in a single YAML document you can read, diff, and teach
from. Gemini is supported natively, Claude via a bundled adapter, and
**open-weight models run locally through Ollama with no key at all**
(`lib/models/ollamaLlm.ts`) — switching any agent's model is a one-line
change. Agents can also extend their own reach at runtime: point a
subagent at an **MCP server** (`mcp_server_url:`) and its tools are
discovered, wrapped, and handed to the agent live.

This is the public companion repository to the interactive curriculum at
**[lyceumagents.com/curriculum](https://lyceumagents.com/curriculum/)** —
a two-part course taught through the syndicates in this repo. Part 1
(LLM fundamentals through single-agent building to basic orchestration)
runs on the open-weight specimens, entirely on your own machine. Part 2
(the Melchizedek protocol: advanced orchestration, memory systems, MCP,
multi-modal review, agentic coding) uses the full framework. You can use
the framework without the course, or the course without running the
framework; together they're better.

## Quick start

Zero keys, fully local — install [Ollama](https://ollama.com), then:

```bash
npm install
ollama pull qwen3:8b
npm run syndicate:hearth   # a single open-weight agent, on your machine
npm run syndicate:agora    # a three-agent council, still no keys
```

With a free Gemini API key, the full syndicate library opens:

```bash
cp .env.example .env    # add your Gemini API key
npm run chat:syndicate  # interactive REPL with the default syndicate
```

Model optionality is one YAML line per agent: `gemini-*`, `claude-*`,
`gpt-*`, `grok-*`, and `ollama/*` ids each route to their provider
(whichever keys you have; local needs none). Prove the whole surface:

```bash
npm run demo:models     # one prompt → every available provider,
                        # with thinking + token/latency traces
```

Full setup — including the optional Supabase database for persistent
sessions and long-term memory — lives in [`QUICKSTART.md`](./QUICKSTART.md).
The complete reference is [`DOCUMENTATION.md`](./DOCUMENTATION.md).
Working with a coding agent? [`AGENT_SETUP.md`](./AGENT_SETUP.md) is a
paste-ready prompt that splits the setup between your agent's steps and
yours, then walks first tests and app integration.

## The syndicates

Every example demonstrates a named orchestration pattern, and each is the
worked specimen for a curriculum module:

| Syndicate | Pattern | Course module |
|---|---|---|
| `hearth.yaml` — Peripatetic Tutor | one open-weight agent, no keys; the instruction block anatomy | [1.01 · agent design](https://lyceumagents.com/curriculum/agent-design/) |
| `agora.yaml` — Agora Council | first orchestration, fully local: advocate/skeptic council | [1.04 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `critic.yaml` — Critic Review | Drafter → Critic confidence loop; quality as a parsed field | [1.03 · testing & refinement](https://lyceumagents.com/curriculum/testing-and-refinement/) |
| `delegation.yaml` — Router | triage to specialists; descriptions as the routing API | [1.04 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `hierarchical.yaml` — Decomposer | split one goal, delegate parts, merge | [1.04 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `style_council.yaml` — Style Council | identical knowledge, three engineered voices | [1.04 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `syndicate.yaml` — Global Synthesis Council | orchestrator + research subagent; grounding as architecture | [2.05 · the protocol](https://lyceumagents.com/curriculum/melchizedek-protocol/) |
| `ares.yaml` — Knowledge Keeper | long-term memory pipeline, exercised | [2.06 · memory systems](https://lyceumagents.com/curriculum/memory-systems/) |
| `patient_advocate.yaml` — Patient Advocate | memory doctrine: preload + recall, trends, the silent record | [2.06 · memory systems](https://lyceumagents.com/curriculum/memory-systems/) |
| `librarian.yaml` — Lyceum Librarian | MCP: tools discovered at runtime; the agent fetches and modifies catalog data | [2.07 · MCP](https://lyceumagents.com/curriculum/mcp-extending-reach/) |
| `image_production.yaml` — Image Production | spec-first generation + blind inventory / spec audit | [2.08 · multi-modal agents](https://lyceumagents.com/curriculum/multimodal-agents/) |
| `claude.yaml` — Claude Chat | minimal single-agent config; the multi-model adapter in one file | — |
| `model_zoo.yaml` — Model Zoo | one lightweight agent per provider (Qwen/Claude/Grok/GPT/Gemini); model optionality proven by `npm run demo:models` | — |

`syndicateSchema.yaml` is the annotated schema reference for authoring
your own.

## What the framework gives you

- **YAML-defined orchestration** — hierarchy, prompts, tools, delegation
  rules, model choices, and output schemas in one declarative file.
- **Multi-model** — Gemini natively; Claude through `lib/models/claudeLlm.ts`;
  open-weight local models through `lib/models/ollamaLlm.ts` (Ollama's
  OpenAI-compatible API — no key, no cloud, `ollama/qwen3:8b` and friends).
  Any agent in a graph can run on a different provider.
- **MCP integration** — a subagent with `mcp_server_url:` discovers a remote
  MCP server's tools at runtime (`lib/tools/mcpToolFactory.ts`), SSRF-guarded.
  A demo catalog server ships in `scripts/demo_mcp_server.ts` (`npm run mcp:demo`).
- **Persistent sessions & semantic memory** — Supabase-backed sessions and
  pgvector long-term memory: session transcripts are distilled into
  structured records (date, source, units, status, index keys), embedded,
  and recalled by similarity plus keys and dates in future sessions;
  corrections supersede old records, which are kept as linked history.
- **Native tools** — web search, image generation, and a blind
  image-inventory tool whose file-path-only signature makes expectation
  bias structurally impossible (see module 05).
- **A2A service mode** — serve any syndicate as a JSON-RPC
  agent-to-agent endpoint with bearer auth and rate limiting
  (`npm run start:a2a`).

## License

MIT — see [`LICENSE`](./LICENSE). Use it, adapt it, learn from it.

---

*This repository is generated from a private working repo by a sanitizing
export script; issues and PRs are welcome here and are folded back
upstream.*
