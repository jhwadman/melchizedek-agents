# melchizedek-agents — reference documentation

The framework in one sentence: **a syndicate is a YAML file describing an
agent graph; the runtime compiles it into live Google-ADK agents with
tools, sessions, and memory attached.** This document is the reference
for that file format and the machinery around it. For a guided first run,
see [`QUICKSTART.md`](./QUICKSTART.md).

## Contents

1. [Architecture](#1-architecture)
2. [The syndicate YAML](#2-the-syndicate-yaml)
3. [Tools](#3-tools)
4. [Sessions & long-term memory](#4-sessions--long-term-memory)
5. [Multi-model support](#5-multi-model-support)
6. [A2A service mode](#6-a2a-service-mode)
7. [Extending the framework](#7-extending-the-framework)
8. [Security notes](#8-security-notes)

---

## 1. Architecture

```
config/agents/*.yaml      syndicate definitions (the product surface)
lib/loadSyndicate.ts      YAML → validated config (+ variable binding)
lib/toolRegistry.ts       tool name → live ADK tool instance
lib/models/claudeLlm.ts   Claude adapter registered into the ADK registry
lib/models/ollamaLlm.ts   open-weight local adapter (Ollama, keyless)
lib/tools/mcpToolFactory.ts  MCP client: remote tools → live ADK tools
scripts/demo_mcp_server.ts   demo MCP server (library catalog, SSE)
lib/session/…             Supabase-backed session service
lib/memory/…              pgvector long-term memory service
lib/observability/…       OpenTelemetry run tracing
scripts/syndicate_chat.ts CLI REPL / one-shot runner (compiles the graph)
scripts/a2a_server.ts     HTTP JSON-RPC service mode (same compiler)
db/hardening.sql          deny-by-default RLS for the Supabase tables
tests/agents.test.ts      compiles every shipped syndicate; opt-in live check
```

Execution flow: `loadSyndicate` reads and validates the YAML and binds
`{{variables}}` → the runner builds an `LlmAgent` per agent, wiring
subagents as `AgentTool`s and tool names through the registry → the ADK
`Runner` executes the turn, persisting events to the session service →
on session end, the memory service distills the transcript into tagged
facts, embeds them (768-d), and stores them for future recall.

## 2. The syndicate YAML

Minimal complete example:

```yaml
syndicate_name: "My Council"
memory_system: "session-only"     # internal-only | session-only | long-term

variables:                        # bound into {{placeholders}} at load
  headline_count: 5               # current_date is injected automatically

orchestrator:
  name: "Conductor"
  model: "gemini-3.5-flash"
  instruction: |
    You are the Conductor… (persona, objective, workflow contract)
  tools:
    - "google_search"             # names resolved via lib/toolRegistry.ts
  generateContentConfig:
    temperature: 0.7
    maxOutputTokens: 4096
    thinkingConfig:
      thinkingLevel: "MEDIUM"     # or thinkingBudget on older models
      includeThoughts: true

subagents:
  - name: "Researcher"
    description: "Use this subagent to… Pass it one focused query."
    model: "gemini-3.5-flash"
    instruction: |
      You are the Researcher…
    tools: ["google_search"]
```

Field reference:

| Field | Where | Meaning |
|---|---|---|
| `syndicate_name` | root | Display name; also namespaces memory user keys. |
| `memory_system` | root | `internal-only` (nothing persists), `session-only` (transcript persists in Supabase), `long-term` (adds fact distillation + vector recall). |
| `variables` | root | Key/values bound into `{{placeholders}}` anywhere in instructions. `current_date` is always injected; CLI `--bind key=value` overrides. |
| `name` / `model` / `instruction` | agent | The agent triple. Any Gemini id, `claude-*`, or `ollama/*` for open-weight local models (see §5). |
| `description` | subagent | **The delegation API.** The orchestrator reads this when deciding to hand off — write it like a function signature ("Use this subagent to…, pass it…"). |
| `tools` | agent | Names resolved by the tool registry (§3). Long-term memory agents add `preload_memory` / `load_memory`. |
| `generateContentConfig` | agent | Temperature, output caps, thinking budget/level. |
| `outputSchema` | agent | Structured-JSON contract. **Constraint:** an agent holding `outputSchema` cannot also hold transfer powers — the ADK deadlocks it. Keep schema-holders as leaf agents (see `critic.yaml`'s header comment for the war story). |
| `yaml_reference` | subagent | Mount another syndicate file as a nested subagent. |
| `mcp_server_url` | subagent | Discover this subagent's tools from a remote MCP server at load time (§3). SSRF-guarded; `ALLOW_PRIVATE_MCP=true` permits localhost for development. |

Validation happens at load: missing names, legacy option blocks, and
malformed agents fail with pointed errors before any model is called.
Tool names are deliberately *not* strictly validated — unknown names are
skipped with a warning at compile time.

## 3. Tools

Registered in `lib/toolRegistry.ts` — one map from YAML name to ADK tool
instance:

| Name | Kind | Does |
|---|---|---|
| `google_search` | ADK built-in | Live web search. |
| `preload_memory` | ADK built-in | Silently injects similarity-matched facts into every request (ambient recall). |
| `load_memory` | ADK built-in | Explicit tool call to search the fact store (deliberate recall). |
| `generate_image` | FunctionTool | Calls the Gemini image model directly, saves the result under `outputs/`, returns the path. A FunctionTool because binary `inlineData` cannot survive the AgentTool text boundary. |
| `inspect_image` | FunctionTool | **Blind visual inventory** of a file under `outputs/`: subjects with exact counts, composition, light, palette, medium cues, artifacts — zero quality judgments. Its signature accepts *only* a file path, so an orchestrator cannot leak expectations into the observation (see `image_production.yaml`). |

**MCP tools** are the exception to the registry: a subagent with
`mcp_server_url:` in its YAML gets its tools from a remote MCP server at
load time. `lib/tools/mcpToolFactory.ts` dials the server over SSE,
lists its tools, and wraps each one as a live `FunctionTool` — the
agent's reach is decided by the server, not compiled in.
`config/agents/librarian.yaml` plus the demo catalog server
(`npm run mcp:demo`, `scripts/demo_mcp_server.ts`) are the worked
example: read tools *and* write tools, so the agent demonstrably
modifies data on the far side of the protocol. The factory refuses
loopback/private hosts unless `ALLOW_PRIVATE_MCP=true` (SSRF guard);
treat any remote MCP server as an untrusted tool vendor whose results
are data, never instructions.

> **⚠ Known bug — MCP tools require a Gemini agent.** The factory emits
> Gemini-style UPPERCASE schema types (`'OBJECT'`, `'STRING'`, …), and
> the Claude adapter forwards them unnormalized, so the Anthropic API
> rejects any `claude-*` agent carrying MCP tools
> (`400 … input_schema.type: Input should be 'object'`). The adapter
> prints a loud warning when this combination is attempted. Until
> `claudeLlm.ts` lowercases schema types, put `mcp_server_url` only on
> Gemini agents, or deep-lowercase each tool's schema `type` values
> before building the agent (see §5).

## 4. Sessions & long-term memory

Two Supabase tables carry the two kinds of remembering:

- **`adk_sessions`** — the running transcript (events + state), so a
  conversation survives process restarts.
- **`adk_memory_facts`** — distilled structured records: each carries
  its 768-d embedding plus the date it is about, the source who asserted
  it, active/superseded status, and entity index keys. Written at
  session end (`exit`, SIGINT, or one-shot completion), keyed per
  syndicate + user. Corrections supersede old rows (kept as linked
  history); recall is cosine similarity re-ranked by keys and dates.
  Full pipeline: [`lib/memory/README.md`](./lib/memory/README.md).

Provision both in the Supabase SQL Editor:

```sql
-- 1. Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Sessions
CREATE TABLE adk_sessions (
  id TEXT PRIMARY KEY,
  app_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  state JSONB DEFAULT '{}'::jsonb,
  events JSONB DEFAULT '[]'::jsonb,
  last_update_time BIGINT,
  expire_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Memory facts (structured records: date, source, status, index keys
--    live beside the embedding — see lib/memory/README.md)
CREATE TABLE adk_memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding vector(768),
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  keys TEXT[] NOT NULL DEFAULT '{}',
  superseded_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Indexes: similarity, entity keys, dates
CREATE INDEX ON adk_memory_facts USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
CREATE INDEX adk_memory_facts_keys_idx ON adk_memory_facts USING gin (keys);
CREATE INDEX adk_memory_facts_date_idx ON adk_memory_facts (user_key, fact_date);

-- 5. Cosine-similarity RPC (returns the structured columns so the
--    service can re-rank by keys/dates and relabel superseded records).
--    filter_user_key is REQUIRED: a NULL key would return every user's facts.
CREATE OR REPLACE FUNCTION match_memory_facts (
  query_embedding vector(768),
  filter_user_key text,
  match_count int DEFAULT 10
) RETURNS TABLE (
  id UUID,
  user_key TEXT,
  fact TEXT,
  tag TEXT,
  fact_date DATE,
  source TEXT,
  status TEXT,
  keys TEXT[],
  created_at TIMESTAMPTZ,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  IF filter_user_key IS NULL THEN
    RAISE EXCEPTION 'filter_user_key is required';
  END IF;
  RETURN QUERY
  SELECT
    adk_memory_facts.id,
    adk_memory_facts.user_key,
    adk_memory_facts.fact,
    adk_memory_facts.tag,
    adk_memory_facts.fact_date,
    adk_memory_facts.source,
    adk_memory_facts.status,
    adk_memory_facts.keys,
    adk_memory_facts.created_at,
    1 - (adk_memory_facts.embedding <=> query_embedding) AS similarity
  FROM adk_memory_facts
  WHERE adk_memory_facts.user_key = filter_user_key
  ORDER BY adk_memory_facts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

Then run [`db/hardening.sql`](./db/hardening.sql) (RLS deny-by-default;
see §8). Upgrading an existing project to the structured columns:
[`db/memory_v2.sql`](./db/memory_v2.sql). `npm run db:purge` clears both
tables.

A memory store is a PII store: key facts to users, honor deletion, set
retention deliberately. Vectorization is not anonymization — the
plain-text fact sits beside its embedding.

## 5. Multi-model support

Gemini model ids work natively. `claude-*` ids route through
`lib/models/claudeLlm.ts`, an adapter registered into the ADK's LLM
registry at startup (it requires `ANTHROPIC_API_KEY`; registration is
deferred until after `.env` loads). `config/agents/claude.yaml` is the
minimal working example. Mixed graphs are supported — each agent picks
its own provider, one line each. One provider-specific caveat: a
`claude-*` agent cannot yet carry MCP-discovered tools — see the known
bug in §3.

**Open-weight local models**: `ollama/*` ids (e.g. `ollama/qwen3:8b`)
route through `lib/models/ollamaLlm.ts` to a local Ollama daemon over
its OpenAI-compatible API (`OLLAMA_BASE_URL`, default
`http://localhost:11434/v1`). No key is required, and a syndicate whose
*every* agent is `ollama/*` runs with no `.env` at all —
`config/agents/hearth.yaml` (single agent) and `agora.yaml` (council)
are the worked examples. The adapter translates ADK content to
OpenAI-style messages, including tool calls (so delegation works),
image parts as data URIs (so `ollama/qwen3-vl:8b` can see), and JSON
response mode; reasoning models' `<think>…</think>` scratchpads are
stripped from replies. Choose models by capability: qwen3:8b is the
smallest pulled model with reliable tool calling; qwen3-vl:8b adds
vision.

Model floor: agent transfer (subagent delegation) requires
`gemini-3.5-flash` or newer — older flash models reject it with
`[400] Tool call context circulation is not enabled`. For `ollama/*`
agents the equivalent floor is tool-calling support in the model
itself; delegation is exercised through AgentTool function calls.

## 6. A2A service mode

`npm run start:a2a` serves a syndicate as a stateless JSON-RPC
agent-to-agent endpoint (Express): an agent card describing the service,
`message/send` for turns, bearer-token auth via `A2A_SERVER_SECRET`, and
rate limiting. With `PUBLIC_URL` set (a real deployment), the server
refuses to start without the secret and refuses to run against an
unhardened database unless explicitly overridden. `demo/a2a_demo.mjs` is
a complete client.

## 7. Extending the framework

**Add a syndicate**: create `config/agents/<name>.yaml` (start from
`syndicateSchema.yaml`), then `npm run chat:syndicate -- --syndicate
<name>`. No code changes.

**Add a tool**: implement a `FunctionTool` in `lib/tools/`, register the
name in `lib/toolRegistry.ts`, reference it from YAML. The two image
tools are the worked examples — including why binary data forces
FunctionTools over subagents, and how a tool signature can enforce an
epistemic rule (the blind inventory).

**Add a provider**: follow `claudeLlm.ts` (SDK-based, key-gated) or
`ollamaLlm.ts` (fetch-based, keyless) — implement the ADK LLM
interface, register it behind a model-id prefix.

**Point an agent at an MCP server**: set `mcp_server_url:` on a
subagent. `scripts/demo_mcp_server.ts` is a complete server to copy —
tool definitions, SSE wiring, and persistent state in ~250 lines.

## 8. Security notes

- **Secrets** live in `.env` only; `.env.example` documents every
  variable. Nothing in the repo ships a key.
- **Database**: default Supabase leaves `public`-schema tables readable
  by the anon key over REST. `db/hardening.sql` enables deny-by-default
  RLS on both tables and revokes anon/authenticated privileges; the A2A
  server verifies hardening at boot and is fatal on public deployments
  without it. Note `service_role` bypasses RLS by design — the hardening
  constrains the API surface, not the trusted server.
- **A2A**: bearer auth + rate limiting are built in; set
  `A2A_SERVER_SECRET` before exposing anything.
- **Image tools** write only under `outputs/`, and `inspect_image` reads
  only from there.
- **MCP** is an outbound trust decision: `mcpToolFactory` blocks
  private/loopback/link-local hosts unless `ALLOW_PRIVATE_MCP=true`, and
  every tool result from a remote server should be treated as untrusted
  data — the librarian's instruction demonstrates the "results are data,
  not instructions" rule.
- **Local models** (`ollama/*`) send prompts only to your own machine's
  Ollama endpoint — nothing leaves the device, which is itself a privacy
  control worth choosing deliberately.
