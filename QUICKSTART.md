# Quickstart

From zero to a running syndicate in five minutes; to persistent memory in
fifteen. The full reference is [`DOCUMENTATION.md`](./DOCUMENTATION.md).

## 1. Prerequisites

- **Node.js 22+** (the CLI uses `--experimental-strip-types` to run
  TypeScript directly — no build step).
- **A Google AI Studio API key** — free at
  [aistudio.google.com](https://aistudio.google.com). This powers all
  Gemini inference and the embedding model behind long-term memory.
- Optional: an **Anthropic API key** (only for `claude-*` models), and a
  free **Supabase project** (only for persistent sessions / memory).

## 2. Install and configure

```bash
npm install
cp .env.example .env
# edit .env → set GOOGLE_GENAI_API_KEY
```

## 3. First run

```bash
npm run chat:syndicate
```

That starts an interactive REPL with the default syndicate (the Global
Synthesis Council: one orchestrator, one research subagent). Type a
question; type `exit` to end. Every syndicate has a shortcut:

```bash
npm run syndicate:delegation    # router → specialists
npm run syndicate:critic        # drafter → critic confidence loop
npm run syndicate:image         # spec-first image production + blind audit
npm run syndicate:advocate      # long-term-memory patient advocate*
```

One-shot mode — pass the question as an argument and the process exits
after answering:

```bash
npm run syndicate:critic -- "In two sentences, why did the Library of Alexandria decline?"
```

## 4. Optional: persistent sessions & long-term memory

Syndicates with `memory_system: "session-only"` or `"long-term"` want a
Supabase backend (without one, sessions fall back to in-memory). Setup:

1. Create a free project at [supabase.com](https://supabase.com).
2. Copy the Project URL and `service_role` key into `.env`
   (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).
3. Run the SQL schema from `DOCUMENTATION.md` §Memory in the Supabase
   SQL Editor (two tables, one index, one similarity function).
4. **Harden it**: run [`db/hardening.sql`](./db/hardening.sql) in the
   same editor — it enables deny-by-default RLS so the anon key can't
   read your session or memory tables over the REST API.

Then run a memory syndicate, tell it something, exit, and start a new
session — it remembers:

```bash
npm run syndicate:ares -- "Remember: my project is called athens-prod."
npm run syndicate:ares -- "What do you know about my project?"
```

`npm run db:purge` wipes your sessions and memory facts when you want a
clean slate.

## 5. Serve a syndicate over HTTP (A2A mode)

```bash
npm run start:a2a
```

Exposes the syndicate as a JSON-RPC agent-to-agent endpoint with an
agent card, bearer-token auth (`A2A_SERVER_SECRET`), and rate limiting.
See `demo/a2a_demo.mjs` for a working client and `DOCUMENTATION.md`
§A2A for the protocol details.

## Common first-run errors

| Symptom | Cause / fix |
|---|---|
| `Gemini API Key is not configured` | `.env` missing or key not set — step 2. |
| `[400] Tool call context circulation is not enabled` | The agent's `model:` is too old for agent transfer. Use `gemini-3.5-flash` or newer (all shipped configs already do). |
| `Model not found` for `claude-*` | `ANTHROPIC_API_KEY` not set in `.env`. |
| Sessions don't persist between runs | Supabase env vars missing (step 4) — the framework fell back to in-memory sessions and said so at boot. |
| Memory tables exist but recall returns nothing | The SQL function `match_memory_facts` wasn't created, or you're querying a different `user_key`. |

## Where to go next

- Read a syndicate the way the course does: start with
  `config/agents/syndicate.yaml` (34 lines) and map its instruction to
  Grounding / Introductions / Directions / Examples.
- The interactive curriculum walks every pattern in this repo:
  [lyceumagents.com/curriculum](https://lyceumagents.com/curriculum/).
- Author your own syndicate: copy `syndicateSchema.yaml`, keep one
  orchestrator and one subagent, and grow only when the work divides.
