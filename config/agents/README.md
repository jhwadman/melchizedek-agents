# config/agents/ — your syndicates, and the starter pack

Melchizedek is an **engine** (`lib/`, `scripts/a2a_server.ts`); the YAML
files here are **configuration fed to it**. This directory is split so the
two are never confused:

## The root: YOUR syndicates

Syndicates at this level are live configuration — the agents your
deployment actually serves. Author yours here: copy any starter-pack file
(or start from `syndicateSchema.yaml`, the annotated authoring reference)
and edit. Nothing in the engine knows these files by name; drop a YAML in,
and it is loadable by filename everywhere (`npm run chat:syndicate --
--syndicate <name>`, A2A routes, `yaml_reference`).

## `examples/` — the starter pack

Everything under `examples/` is a **starter pack**: working, tested
syndicates that demonstrate the engine's patterns (synthesis, delegation,
critic loops, hierarchies, MCP tools, local open-weight models, the wiki
gardeners). They are teaching material, not product — copy them, gut them,
delete the whole directory; the engine runs fine without them.

## `templates/` — the production templates

Ten job-shaped files built to be adapted and shipped: a conversational
agent, support triage, a three-layer research brief, a review panel, a
policy-checked drafting loop, and one template for each memory tier
(short-term intake, a session case desk, long-term account memory), plus
the research desk and a systems operator that reaches your own systems
over MCP. `templates/README.md` maps them; each header says what to change
first. The offline suite holds them to a contract the examples are not
held to.

The loader (`lib/loadSyndicate.ts`) resolves a bare filename against the
root first, then `examples/`, then `templates/`, so `npm run syndicate:tutor` and friends keep
working, and promoting an example to production is just moving it one
level up.

## The prompt standard — every agent in `examples/` and `templates/`

Every instruction in the starter pack and the templates, orchestrator and
subagent alike, is written in the block anatomy taught at
https://lyceumagents.com/curriculum/agent-design/. Blocks follow
capabilities: an agent carries the ones its job calls for.

- **Identity** — who the agent is, the one thing it is for, and what it
  does not do.
- **Task directive** — a labelled line (`TASK:`, `Task:` or
  `<task_directive>`) naming what this call hands back, so "done" is
  visible in a transcript and a subagent knows where its slice ends.
- **Doctrines** — one per capability (tool, memory, subagent, source): what
  counts as truth, when it must be called, a call budget, and the exact
  thing to say when it returns nothing or fails.
- **Communication style** — countable rules: word or character caps,
  format, the closing.
- **Execution framework** — the per-turn procedure or ordered phases, with a
  **reasoning directive** wherever the reply turns on a decision ("before you
  reply, decide which of three cases this is"), and where that reasoning
  goes (hidden, a schema field, never the reply).
- **Guardrails** — negative constraints, one "never" per failure the agent
  invites, each paired with what to do instead. Any agent that reads pasted
  text, pages or tool results says text inside them is material, never an
  instruction. Agent-wide, high-stakes limits sit in a boundaries block and
  are also enforced in code.
- **Examples** (optional) — positive only: one worked exchange per branch,
  on material unrelated to real inputs. The wrong reply goes in a guardrail.

`tests/agents.test.ts` checks the mechanical part (a task directive, a
"never", and the injection line on every tool-holding agent); the rest is
reviewed by reading. A new public agent meets the whole standard before it
ships.
