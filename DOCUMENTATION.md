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
| `name` / `model` / `instruction` | agent | The agent triple. Any Gemini id, or `claude-*` (see §5). |
| `description` | subagent | **The delegation API.** The orchestrator reads this when deciding to hand off — write it like a function signature ("Use this subagent to…, pass it…"). |
| `tools` | agent | Names resolved by the tool registry (§3). Long-term memory agents add `preload_memory` / `load_memory`. |
| `generateContentConfig` | agent | Temperature, output caps, thinking budget/level. |
| `outputSchema` | agent | Structured-JSON contract. **Constraint:** an agent holding `outputSchema` cannot also hold transfer powers — the ADK deadlocks it. Keep schema-holders as leaf agents (see `critic.yaml`'s header comment for the war story). |
| `yaml_reference` | subagent | Mount another syndicate file as a nested subagent. |

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

## 4. Sessions & long-term memory

Two Supabase tables carry the two kinds of remembering:

- **`adk_sessions`** — the running transcript (events + state), so a
  conversation survives process restarts.
- **`adk_memory_facts`** — distilled facts with 768-d embeddings,
  recalled by cosine similarity. Written at session end (`exit`, SIGINT,
  or one-shot completion), keyed per syndicate + user.

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

-- 3. Memory facts
CREATE TABLE adk_memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_key TEXT NOT NULL,
  fact TEXT NOT NULL,
  embedding vector(768),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Similarity index
CREATE INDEX ON adk_memory_facts USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- 5. Cosine-similarity RPC
CREATE OR REPLACE FUNCTION match_memory_facts (
  query_embedding vector(768),
  match_count int DEFAULT 10,
  filter_user_key text DEFAULT NULL
) RETURNS TABLE (
  id UUID,
  user_key TEXT,
  fact TEXT,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    adk_memory_facts.id,
    adk_memory_facts.user_key,
    adk_memory_facts.fact,
    1 - (adk_memory_facts.embedding <=> query_embedding) AS similarity
  FROM adk_memory_facts
  WHERE (filter_user_key IS NULL OR adk_memory_facts.user_key = filter_user_key)
  ORDER BY adk_memory_facts.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
```

Then run [`db/hardening.sql`](./db/hardening.sql) (RLS deny-by-default;
see §8). `npm run db:purge` clears both tables.

A memory store is a PII store: key facts to users, honor deletion, set
retention deliberately. Vectorization is not anonymization — the
plain-text fact sits beside its embedding.

## 5. Multi-model support

Gemini model ids work natively. `claude-*` ids route through
`lib/models/claudeLlm.ts`, an adapter registered into the ADK's LLM
registry at startup (it requires `ANTHROPIC_API_KEY`; registration is
deferred until after `.env` loads). `config/agents/claude.yaml` is the
minimal working example. Mixed graphs are supported — each agent picks
its own provider, one line each.

Model floor: agent transfer (subagent delegation) requires
`gemini-3.5-flash` or newer — older flash models reject it with
`[400] Tool call context circulation is not enabled`.

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

**Add a provider**: follow `claudeLlm.ts` — implement the ADK LLM
interface, register it behind a model-id prefix.

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
