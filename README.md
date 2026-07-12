# melchizedek-agents

**A multi-model, multi-agent orchestration framework built on the Google
Agent Development Kit — where the entire shape of an agent system is one
readable YAML file.**

Melchizedek runs hierarchical agent graphs called *Syndicates*: an
orchestrator, its subagents, their tools, models, and communication laws,
all declared in a single YAML document you can read, diff, and teach
from. Gemini is supported natively and Claude via a bundled adapter —
switching any agent's model is a one-line change.

This is the public companion repository to the interactive curriculum at
**[lyceumagents.com/curriculum](https://lyceumagents.com/curriculum/)** —
six lessons on agent design, workflows and voice, testing loops, memory
systems, multi-modal review, and agentic coding, each taught through a
syndicate in this repo. You can use the framework without the course, or
the course without running the framework; together they're better.

## Quick start

```bash
npm install
cp .env.example .env    # add your Gemini API key
npm run chat:syndicate  # interactive REPL with the default syndicate
```

Full setup — including the optional Supabase database for persistent
sessions and long-term memory — lives in [`QUICKSTART.md`](./QUICKSTART.md).
The complete reference is [`DOCUMENTATION.md`](./DOCUMENTATION.md).

## The syndicates

Every example demonstrates a named orchestration pattern, and each is the
worked specimen for a curriculum module:

| Syndicate | Pattern | Course module |
|---|---|---|
| `syndicate.yaml` — Global Synthesis Council | orchestrator + research subagent; grounding as architecture | [01 · agent design](https://lyceumagents.com/curriculum/agent-design/) |
| `delegation.yaml` — Router | triage to specialists; descriptions as the routing API | [02 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `hierarchical.yaml` — Decomposer | split one goal, delegate parts, merge | [02 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `style_council.yaml` — Style Council | identical knowledge, three engineered voices | [02 · workflows & voice](https://lyceumagents.com/curriculum/workflows-and-voice/) |
| `critic.yaml` — Critic Review | Drafter → Critic confidence loop; quality as a parsed field | [03 · testing & refinement](https://lyceumagents.com/curriculum/testing-and-refinement/) |
| `ares.yaml` — Knowledge Keeper | long-term memory pipeline, exercised | [04 · memory systems](https://lyceumagents.com/curriculum/memory-systems/) |
| `patient_advocate.yaml` — Patient Advocate | memory doctrine: preload + recall, trends, the silent record | [04 · memory systems](https://lyceumagents.com/curriculum/memory-systems/) |
| `image_production.yaml` — Image Production | spec-first generation + blind inventory / spec audit | [05 · multi-modal agents](https://lyceumagents.com/curriculum/multimodal-agents/) |
| `claude.yaml` — Claude Chat | minimal single-agent config; the multi-model adapter in one file | — |

`syndicateSchema.yaml` is the annotated schema reference for authoring
your own.

## What the framework gives you

- **YAML-defined orchestration** — hierarchy, prompts, tools, delegation
  rules, model choices, and output schemas in one declarative file.
- **Multi-model** — Gemini natively; Claude through `lib/models/claudeLlm.ts`.
  Any agent in a graph can run on a different provider.
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
