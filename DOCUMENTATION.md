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
9. [The knowledge bundle (wiki/)](#9-the-knowledge-bundle-wiki)

---

## 1. Architecture

```
config/agents/            YOUR syndicate definitions (the engine's input)
config/agents/examples/   the starter pack — shipped example syndicates
lib/loadSyndicate.ts      YAML → validated config (+ variable binding)
lib/dispatch.ts           plan-dispatch route resolution (§6)
lib/toolRegistry.ts       tool name → live ADK tool instance
lib/models/claudeLlm.ts   Claude adapter registered into the ADK registry
lib/models/ollamaLlm.ts   open-weight local adapter (Ollama, keyless)
lib/tools/mcpToolFactory.ts  MCP client: remote tools → live ADK tools
scripts/demo_mcp_server.ts   demo MCP server (library catalog, SSE)
lib/session/…             Supabase-backed session service
lib/memory/…              pgvector long-term memory service
lib/observability/…       OpenTelemetry run tracing
lib/runtime/syndicateTurn.ts  THE turn runner: every surface below calls it
lib/a2a/app.ts            the A2A server as a library (createA2AApp)
lib/a2a/remoteAgent.ts    A2A client: remote agents as subagents
scripts/syndicate_chat.ts CLI REPL / one-shot runner
scripts/a2a_server.ts     the A2A server bin (melchizedek-serve)
db/schema.sql             the base schema (sessions, memory, expiry)
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

# guards: [my_guard]              # [optional] post-answer guards, by name

variables:                        # bound into {{placeholders}} at load
  headline_count: 5               # current_date is injected automatically

orchestrator:
  name: "Conductor"
  model: "gemini-3.8-flash"
  instruction: |
    You are the Conductor… (persona, objective, workflow contract)
  tools:
    - "google_search"             # names resolved via lib/toolRegistry.ts
  generateContentConfig:
    maxOutputTokens: 4096
    thinkingConfig:
      thinkingLevel: "MEDIUM"     # or thinkingBudget on older models
      includeThoughts: true

subagents:
  - name: "Researcher"
    description: "Use this subagent to… Pass it one focused query."
    model: "gemini-3.8-flash"
    instruction: |
      You are the Researcher…
    tools: ["google_search"]
```

Field reference:

| Field | Where | Meaning |
|---|---|---|
| `syndicate_name` | root | Display name. On the CLI it also namespaces memory user keys; on the A2A server memory is keyed by the caller's silo across every long-term syndicate that server serves. |
| `memory_system` | root | `internal-only` (nothing persists — on the server too: its transcripts stay in process memory), `session-only` (transcript persists in Supabase), `long-term` (adds fact distillation + vector recall). |
| `variables` | root | Key/values bound into `{{placeholders}}` anywhere in instructions. `current_date` is always injected; CLI `--bind key=value` overrides. |
| `memory_extraction_rules` | root | Domain rules appended to the shared fact-extraction prompt for THIS syndicate only (requires `memory_system: "long-term"`). The extraction prompt is global — anything domain-specific belongs here, never edited into it. Unset, the prompt renders byte-identical to before the slot existed (§4). |
| `dispatch` | root | Switches the syndicate from DELEGATE to PLAN-DISPATCH routing (§6). `default_route` (required) names the fail-static subagent; `route_key` / `reason_key` name the router's JSON properties (defaults `route` / `reason`). Honoured by every surface (the CLI, the server, the worker, evals). |
| `guards` | root | Optional list of post-answer guard NAMES (`lib/guards/index.ts`). Each runs after the answering turn and before the reply publishes, receiving the final text plus every tool-result text of that turn, and rewrites in place rather than re-asking the model; its notes land in the `[STATUS]` stream. Guards declared by a syndicate reached through `yaml_reference:` count too — the server resolves the union via `collectGuards()`. Resolved by name, never by module path, so adding one is a deliberate act in code; **the published registry ships one, `science`** (citation checks for `research.yaml`); `registerGuard()` adds your own from code, and an unregistered name is warned about and skipped. |
| `name` / `model` / `instruction` | agent | The agent triple. Any Gemini id, `claude-*`, or `ollama/*` for open-weight local models (see §5). |
| `description` | subagent | **The delegation API.** The orchestrator reads this when deciding to hand off — write it like a function signature ("Use this subagent to…, pass it…"). |
| `tools` | agent | Names resolved by the tool registry (§3). Long-term memory agents add `preload_memory` / `load_memory`. |
| `generateContentConfig` | agent | Temperature, output caps, thinking budget/level. |
| `outputSchema` | agent | Structured-JSON contract. **Constraint:** an agent holding `outputSchema` cannot also hold transfer powers — the ADK deadlocks it. Keep schema-holders as leaf agents (see `critic.yaml`'s header comment for the war story). |
| `yaml_reference` | subagent | Mount another syndicate file as a nested subagent. |
| `a2a_agent_url` | subagent | A REMOTE agent over A2A (§6): the orchestrator delegates to it with one `request` argument; in plan-dispatch it can be a route. No `model`/`instruction` — the remote agent has its own. Credentials come from `A2A_AGENT_TOKENS`, never YAML. |
| `max_steps` | root | Cap on model calls per turn, counted across every agent the turn reaches (orchestrator, subagents, nested syndicates). Exceeding it fails the turn with `STEP_LIMIT`. |
| `includeContents` / `outputKey` / `globalInstruction` / `disallowTransferToParent` / `disallowTransferToPeers` | agent | Passed through to ADK's LlmAgent. `includeContents: none` makes an agent see only the current message. |
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
| `web_search` | Provider-agnostic | Live web search via the agent model's NATIVE search: Gemini grounding, Anthropic `web_search` server tool, OpenAI Responses `web_search`, xAI Agent Tools `web_search`. On local `ollama/*` models the tool is omitted with a one-time warning (keyless stays keyless). On grok-* agents, optional server-side domain filters via `XAI_WEB_SEARCH_ALLOWED_DOMAINS` / `_EXCLUDED_DOMAINS` in `.env` (max 5, mutually exclusive; xAI accepts no date bounds — those are `x_search`-only). Prefer this in new YAMLs. |
| `web_extract` | FunctionTool | Deterministic page reading: fetches 1–5 agent-chosen URLs and returns clean page text (no LLM summarization). Keyless — works on every provider including local `ollama/*`. Per-page char budget (default 15k, `WEB_EXTRACT_CHAR_LIMIT`); long pages return a head+tail window with an `offset` continuation call served from a 15-minute cache. SSRF-guarded (http(s) only, private/link-local hosts refused, redirects re-checked). Block pages (bot checks, paywall stubs, JS shells) are detected code-side and returned as labeled `Error:` blocks, never as content. Pair with `web_search`: search to find, extract to read past the headline. |
| `x_search` | xAI-only | Live search over X (Twitter) posts via xAI Agent Tools. Self-gates to `grok-*` agents; a silent no-op on every other provider, so mixed-provider YAMLs stay safe. Optional server-side constraints in `.env`: `XAI_X_SEARCH_FROM_DATE`/`_TO_DATE` (inclusive `YYYY-MM-DD`) and `_ALLOWED_HANDLES`/`_EXCLUDED_HANDLES` (max 20, mutually exclusive — allowlist wins). |
| `collections_search` | xAI-only | Semantic search over xAI **Collections** — hosted document stores (PDFs/text/CSVs) uploaded at console.x.ai — server-side RAG with `collections://…` citations. Which collections: `XAI_COLLECTION_IDS` in `.env` (optional `XAI_COLLECTIONS_MAX_RESULTS`). Declared with no ids → omitted with a warning; non-xAI providers → silent no-op. |
| `google_search` | ADK built-in | Live web search — Gemini agents only (legacy alias; use `web_search`). |
| `preload_memory` | ADK built-in | Silently injects similarity-matched facts into every request (ambient recall). |
| `load_memory` | ADK built-in | Explicit tool call to search the fact store (deliberate recall). |
| `generate_image` | FunctionTool | Calls the Gemini image model directly, saves the result under `outputs/`, returns the path. A FunctionTool because binary `inlineData` cannot survive the AgentTool text boundary. |
| `inspect_image` | FunctionTool | **Blind visual inventory** of a file under `outputs/`: subjects with exact counts, composition, light, palette, medium cues, artifacts — zero quality judgments. Its signature accepts *only* a file path, so an orchestrator cannot leak expectations into the observation (see `image_production.yaml`). |
| `task_add` / `task_list` / `task_get` / `task_update` | FunctionTool | A to-do list in a local JSON store (`MELCHIZEDEK_TASKS_FILE`, default `outputs/tasks.json`). Single-user: the store has no caller identity, so never serve these tools on a shared A2A endpoint. |
| `task_queue` | FunctionTool | Queues a background job (a self-contained instruction). The tool only writes the queue; `npm run assistant:worker` (`melchizedek-worker`) claims each job, runs it through one agent compiled from YAML (default: the Assistant's Worker), and writes the result back for `task_get`. `--once` drains and exits, for cron. |

**MCP tools** are the exception to the registry: a subagent with
`mcp_server_url:` in its YAML gets its tools from a remote MCP server at
load time. `lib/tools/mcpToolFactory.ts` dials the server over SSE,
lists its tools, and wraps each one as a live `FunctionTool` — the
agent's reach is decided by the server, not compiled in.
`config/agents/examples/librarian.yaml` plus the demo catalog server
(`npm run mcp:demo`, `scripts/demo_mcp_server.ts`) are the worked
example: read tools *and* write tools, so the agent demonstrably
modifies data on the far side of the protocol. The factory refuses
loopback/private hosts unless `ALLOW_PRIVATE_MCP=true` (SSRF guard);
treat any remote MCP server as an untrusted tool vendor whose results
are data, never instructions.

> **Schema dialects, handled for you.** The factory emits Gemini-style
> UPPERCASE schema types (`'OBJECT'`, `'STRING'`, …) because the ADK is
> Gemini-native; every non-Gemini adapter normalizes them back to
> standard lowercase JSON-Schema at request-build time
> (`lib/models/schemaNormalize.ts`). MCP tools therefore work on any
> provider's agents — Gemini, Claude, GPT, or Grok.

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

Install both, with their indexes, the recall function and the nightly
session expiry, from the one canonical file:

```bash
npx melchizedek-db print     # paste into the Supabase SQL Editor (clone: npm run db -- print)
npx melchizedek-db apply     # or apply with psql, DATABASE_URL set
npx melchizedek-db status    # schema version, hardening, session counts
```

That runs the migrations in [`db/migrations/`](./db/migrations/) and then
[`db/hardening.sql`](./db/hardening.sql). Both are idempotent, so re-running
them is also the upgrade path from any earlier layout.

Then run [`db/hardening.sql`](./db/hardening.sql) (RLS deny-by-default;
see §8). Upgrading an existing project to the structured columns:
[`db/memory_v2.sql`](./db/memory_v2.sql). `npm run db:purge` clears both
tables; for per-record inspection and hand-clearing, `npm run memory`
(`scripts/memory_admin.ts`) lists silos, groups likely restatements
(`--dupes`), and deletes chosen records — a dry run unless `--yes`, with
every delete scoped to its `--silo`. Cleanup means DELETE, not
`status='superseded'`: `match_memory_facts` filters on `user_key` alone
and applies status afterwards in the re-rank, so a retired row still
consumes a candidate slot (see `lib/memory/README.md`).

**Ingestion is incremental, and dedup is semantic.** A stateless service
(the A2A server, §6) ingests after *every* completed task with the whole
session — so an N-turn conversation would be distilled N times over a
growing transcript, and byte-equality dedup never catches it because the
extraction model rephrases on each pass. Two mechanisms in
`lib/memory/supabaseMemoryService.ts` prevent the store from filling
with restatements:

- A per-session **high-water mark** (`eventsToIngest`) distils only the
  turns added since the last ingestion. It is in-process on purpose — a
  restart re-reads one session once, absorbed by the check below, which
  is why it needs no table of its own.
- A **similarity probe** before each insert (`isSemanticDuplicate`,
  `MEMORY_DEDUP_SIMILARITY = 0.93`) drops restatements, reusing the same
  `match_memory_facts` RPC the supersession path calls. It requires the
  same tag — an `[EPISODE]` about a topic must never suppress the
  `[FACT]` it mentions — and retired rows never suppress a new one. A
  probe that errors **fails open and stores**: a duplicate costs a
  shortlist slot, a lost fact costs the user something they said.

**Per-consumer extraction rules.** The fact-extraction prompt is shared
by every long-term consumer, so domain rules arrive through the
`memory_extraction_rules` field on the syndicate (§2) rather than being
edited into the prompt. It fills a `{domain_rules}` slot that renders
empty when unset — a syndicate declaring none gets byte-identical
behaviour to before the slot existed. Use it to say what is worth
remembering in your domain: what the user asserted, decided, or
committed to is usually worth storing; a value that goes stale on its
own usually is not, because a stored copy can never be used, only crowd
out records that can. `config/agents/syndicateSchema.yaml` shows the
shape.

A memory store is a PII store: key facts to users, honor deletion, set
retention deliberately. Vectorization is not anonymization — the
plain-text fact sits beside its embedding.

## 5. Multi-model support

The agent's `model:` id names its provider, and the framework routes
accordingly — model optionality is a single YAML line per agent:

| Model id | Provider | Adapter | Key | Native `web_search` |
|---|---|---|---|---|
| `gemini-*` | Google Gemini | ADK-native (`TracedGemini`) | `GOOGLE_GENAI_API_KEY` | ✅ grounding |
| `claude-*` | Anthropic | `lib/models/claudeLlm.ts` | `ANTHROPIC_API_KEY` | ✅ server tool |
| `gpt-*`, o-series | OpenAI | `lib/models/gptLlm.ts` (Responses API) | `OPENAI_API_KEY` | ✅ web_search tool |
| `grok-*` | xAI | `lib/models/grokLlm.ts` (Responses API) | `XAI_API_KEY` | ✅ Agent Tools search |
| `ollama/*` | Local Ollama | `lib/models/ollamaLlm.ts` | none | ⚠ omitted + warning |
| *any cloud id whose direct key is absent* | the id's own provider, via a gateway | `lib/models/gatewayLlm.ts` (chat completions) | `MODEL_GATEWAY` + `MODEL_GATEWAY_API_KEY` | ⚠ omitted + reported |

The xAI adapter carries the deepest capability surface: `grok-4.5`
requests pin `reasoning.effort: "medium"` (`lib/config.ts`), SSE
streaming works end-to-end (`runConfig: { streamingMode: 'sse' }` —
partial delta events stream, one aggregated event persists with usage),
structured outputs ride `outputSchema` → `text.format`, and two
xAI-only tools — `x_search` and `collections_search` (§3) — turn on
live X search and hosted-document RAG. All verified live on grok-4.5.

**Which keys do I need?** `npm run doctor` (the `melchizedek-doctor` bin)
reads every syndicate YAML, resolves each agent's model under your `.env`,
and prints one table — agent, model, provider, which declared server-side
tools that path runs natively (✓) or drops (✗), and whether the path is
funded — with one verdict per syndicate and the variables that would
unlock the most. Read-only; no key value is ever printed. Every
starter-pack file opens with a `# tier:` header (`keyless`, one provider
such as `gemini`, or `multi-provider`) the doctor checks against the
models. `GOOGLE_GENAI_API_KEY` alone runs fourteen of the nineteen examples.

**One key instead of several — the gateway fallback.** Direct adapters
are canonical: the native features above exist only on a provider's own
endpoint. But with `MODEL_GATEWAY=vercel` (or `openrouter`) and
`MODEL_GATEWAY_API_KEY` set, any cloud model id whose direct key is
*absent* is served through that gateway's OpenAI-compatible endpoint
(`lib/models/gateway.ts` owns the rule). A present provider key always
wins for its own ids, Ollama never routes through a gateway, and adding a
direct key later restores that provider's native search with no YAML
change. Through the gateway every server-side sentinel (`web_search`,
`google_search`, `x_search`, `collections_search`) is dropped — the doctor
and the startup log say so per agent, and the span records
`llm.transport = gateway:<id>` and `llm.capability.dropped` while
`llm.provider` keeps the upstream attribution. Tool calling, structured
output, `reasoning_effort` and streaming work unchanged. Optional dials:
`MODEL_GATEWAY_BASE_URL` (a self-hosted proxy speaking the same dialect),
`MODEL_GATEWAY_MODEL_MAP` (`from=to,…` wire-name overrides; the mapper
already turns `claude-sonnet-4-6` into `anthropic/claude-sonnet-4.6`). The
A2A `X-API-Key` never selects the gateway — the gateway key is server
environment only.

`lib/models/registry.ts` is the single routing seam:
`registerAvailableProviders()` registers every adapter whose key is
present (Ollama needs none) into the ADK's LLM registry, so the YAML
string finds its provider; missing keys produce clear skip messages,
and only the providers a syndicate actually declares are required.
Mixed graphs are supported — each agent picks its own provider, one
line each. `config/agents/examples/claude.yaml` is the minimal Claude example;
`config/agents/examples/model_zoo.yaml` declares one lightweight agent per
provider, and `npm run demo:models` proves the whole surface: one
prompt to every available provider, printing input, thinking (qwen3
`<think>` blocks, Claude extended thinking, GPT reasoning summaries,
Grok reasoning), output, and a per-request token/latency trace; add
`-- --search` to watch four native web searches plus the local
omission. Providers without keys are skipped, never fatal.

Reasoning/thinking: scratchpads from every provider are surfaced as
dimmed THINKING output and kept out of session history. On Claude,
`generateContentConfig.thinkingConfig.thinkingBudget` enables
Anthropic extended thinking (thinking + tool use on the same Claude
agent is not supported yet).

Every model request also emits an `llm.request` OpenTelemetry span
(provider, model, input/output/thinking tokens, latency). Scripts print it
as an `[OTEL_SPAN_JSON]` line; `melchizedek-chat` and the `syndicate:*`
scripts keep those lines off unless `OTEL_CONSOLE_SPANS=true`. Set
`TELEMETRY_SUPABASE=true` to persist
spans to the `adk_telemetry` table (run `db/telemetry.sql`, then
re-run `db/hardening.sql` — schema below):

`db/telemetry.sql` (idempotent) creates three tables: `adk_turns` — one
row per turn with input, output, the responding agent, the plan-dispatch
route, errors, tokens, model-vs-tool latency, the tool calls with their
responses, the ids that join it to `adk_sessions` (`session_id`,
`invocation_id`), provenance (`config_hash`, `engine_version`) and a
full-text `search` column; `adk_telemetry` — one row per `llm.request` /
root span; and `adk_payloads` — full prompts and responses per model call,
kept by policy (`TELEMETRY_PAYLOADS=off|errors|sample|all`,
`TELEMETRY_PAYLOAD_SAMPLE`, `TELEMETRY_PAYLOAD_TTL_DAYS`) and expired by
`melchizedek_prune_telemetry()`. The view `adk_turns_production` excludes
eval and classifier turns. Operate it with `npm run telemetry:stats`,
`telemetry:prune` and `telemetry:replay` (the exporter spools failed
batches to `outputs/telemetry-deadletter.ndjson`).

**Open-weight local models**: `ollama/*` ids (e.g. `ollama/qwen3:8b`)
route through `lib/models/ollamaLlm.ts` to a local Ollama daemon over
its OpenAI-compatible API (`OLLAMA_BASE_URL`, default
`http://localhost:11434/v1`). No key is required, and a syndicate whose
*every* agent is `ollama/*` runs with no `.env` at all —
`config/agents/examples/tutor.yaml` (single agent), `council.yaml` (council)
and `assistant.yaml` (conversation, summaries, a task list, background jobs)
are the worked examples. The adapter translates ADK content to
OpenAI-style messages, including tool calls (so delegation works),
image parts as data URIs (so `ollama/qwen3-vl:8b` can see), and JSON
response mode; reasoning models' `<think>…</think>` scratchpads are
stripped from replies. Choose models by capability: qwen3:8b is the
smallest pulled model with reliable tool calling; qwen3-vl:8b adds
vision.

Model floor: agent transfer (subagent delegation) requires
`gemini-3.8-flash` or newer — older flash models reject it with
`[400] Tool call context circulation is not enabled`. For `ollama/*`
agents the equivalent floor is tool-calling support in the model
itself; delegation is exercised through AgentTool function calls.

## 6. A2A service mode

`npm run start:a2a -- <file>.yaml` (package: `npx melchizedek-serve
<file>.yaml`) serves a syndicate as an A2A 1.0 agent that also accepts A2A
0.3 clients (most platforms still speak 0.3; a request without an
`A2A-Version` header is treated as 0.3, per the spec): an agent card listing
both versions' endpoints, JSON-RPC and REST transports, and the task
lifecycle. In your own Express
app, mount `(await createA2AApp(options)).app` instead — same server, same
options. `demo/a2a_demo.mjs` is a complete client.

#### Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | liveness — always 200 while the process runs |
| `GET /readyz` | none | readiness — 503 while draining for shutdown |
| `GET /.well-known/agent-card.json` | bearer | the default syndicate's card |
| `POST /a2a/jsonrpc`, `/a2a/rest` | bearer | the default syndicate |
| `GET /<agentId>/.well-known/agent-card.json` | bearer | another syndicate's card; its URLs point at `/<agentId>/a2a/...` |
| `POST /<agentId>/a2a/jsonrpc`, `/<agentId>/a2a/rest` | bearer | another syndicate (`A2A_SERVED_AGENTS` restricts which) |
| `DELETE /memory` | bearer | erase everything stored for the calling scope: facts, sessions (with subagent rows) and ledger rows, with per-store counts; `?all=1` covers every memory namespace |

"bearer" applies only when `A2A_SERVER_SECRET` is set. In BYOK mode every
task route also needs `X-API-Key`. The card declares what is required in
`securitySchemes`.

#### Who pays, and whose data it is

`A2A_KEY_MODE` (option `keyMode`) decides:

- **`server`** (default): the server's own provider keys pay for every
  model call (or your `credentials` plug point supplies a key per request).
  Data is stored under `X-User-Id`, or `default` without it.
- **`byok`**: the caller's `X-API-Key` funds agents on the provider named
  by `X-Provider`; agents on other providers, tools and memory extraction
  still run on the server's keys. Data is stored under a hash of that key,
  plus `X-User-Id` beneath it, so key holders cannot reach one another's
  data. This was the only behaviour before 0.16: a deployment holding data
  from then must keep `byok` until that data is re-keyed.

With `createA2AApp({ resolveRequest })` your own identity system (a JWT
check, a gateway header) returns the scope key instead, and both header
contracts are ignored.

#### Headers

| Header | Meaning |
|---|---|
| `Authorization: Bearer <secret>` | the server secret |
| `X-User-Id` | the end user this request is for (`[A-Za-z0-9._-]{1,64}`); sessions and memory are stored under it. Authenticate your users before sending it. |
| `X-API-Key` | BYOK mode only: the caller's model key (see above) |
| `X-Provider` | BYOK mode only: which provider `X-API-Key` belongs to (default `google`) |
| `X-Surface`, `X-Surface-Guild`, `-Channel`, `-User` | optional, telemetry only |

#### Sessions

`message.contextId` names the conversation — it goes **inside** `message`.
Calls with the same value continue one session; a `contextId` beside
`message` is ignored and every call starts fresh. Sessions are durable with
Supabase and expire seven days after the last turn (a nightly prune from
`db/migrations/0001_base.sql` deletes them). A syndicate declaring `memory_system: internal-only` keeps its
transcripts in process memory even when Supabase is configured.

#### Tasks, streaming, cancel

(Method names below are 0.3's; 1.0 clients use `SendMessage`,
`GetTask`, `SendStreamingMessage`, `CancelTask` and the 1.0 enum spellings.)
`message/send` blocks until the turn finishes unless the request sets
`configuration.blocking: false`; then poll `tasks/get`. `message/stream`
emits `[STATUS]` progress updates (tool calls, the chosen route, guard
notes) and the answer as the final status message — progress events, not
token deltas. `tasks/cancel` stops a running task, including the model call
in flight, and the task ends `canceled`. Final states: `completed`,
`failed` (the message names the stage and the provider's reason),
`canceled`, `rejected` (a file part, an empty message, or the server at
capacity). Message parts may be `text` or `data` (sent to the model as
JSON); `file` parts are refused.

#### Limits

| Setting | Default |
|---|---|
| `A2A_RATE_LIMIT_MAX` per `A2A_RATE_LIMIT_WINDOW_MS`, per client IP (POSTs) | 60 per 15 min |
| `A2A_AUTH_FAILURE_MAX` failed logins per IP per 15 min, then blocked | 30 |
| `A2A_TASK_TIMEOUT_MS` per task | 15 min |
| `A2A_MAX_CONCURRENT_TASKS` | unlimited |
| `max_steps` (YAML): model calls per turn, subagents included | none |
| `A2A_BODY_LIMIT` | 1 MB |
| `A2A_SHUTDOWN_GRACE_MS`: SIGTERM waits for running tasks | 25 s |

#### What is per-process

Tasks, the per-agent config cache (a config change needs a restart) and the
rate-limit counters live in the process. Run one replica, or route each
conversation to one replica, until the task store is durable.

#### Posture at boot

Without `A2A_SERVER_SECRET` the server binds `127.0.0.1` only; binding
another `HOST` requires the secret or `ALLOW_UNAUTHENTICATED=true`. With
`PUBLIC_URL` set it refuses to start without the secret, with the
`.env.example` placeholder as the secret, or against an unhardened
database (unless `ALLOW_UNHARDENED_DB=true`). Conversation content is not
printed to stdout unless `OTEL_CONSOLE_SPANS=true`.

#### Calling remote agents

A subagent with `a2a_agent_url: https://other-team.example/billing` is a
REMOTE agent, speaking A2A 1.0 or 0.3 (the card decides): the orchestrator
delegates to it as to a local subagent (one `request` argument), and in
plan-dispatch it can be a route. Its card and
endpoint pass the SSRF guard (`ALLOW_PRIVATE_A2A=true` for local hosts);
credentials come from `A2A_AGENT_TOKENS`, a JSON map of host → bearer
token or host → headers, sent only over https (or to loopback). The same
local conversation keeps talking to the same remote conversation.

#### Deploying

`Dockerfile` builds the compiled server and runs it as a non-root user with
a health check; `compose.yaml` adds optional Ollama and Phoenix (traces).
`npx melchizedek-db print|apply|status` installs and checks the database.
Set `PUBLIC_URL`, `A2A_SERVER_SECRET` and the provider keys from your
secret manager; give the orchestrator's stop timeout at least
`A2A_SHUTDOWN_GRACE_MS`.

### Plan-dispatch routing (`dispatch:`) — the second orchestration method

A syndicate that declares a `dispatch:` block stops delegating and
starts **dispatching**. The two methods differ in who speaks to the
user:

| | DELEGATE (default) | PLAN-DISPATCH (`dispatch:` present) |
|---|---|---|
| Subagents are | `AgentTool`s on the orchestrator | plain configs the server selects from |
| Orchestrator holds | subagent tools, no `outputSchema` | an `outputSchema`, no subagent tools |
| Routing decision is | implicit in which tool it calls | an explicit value in code |
| The final answer comes from | the orchestrator re-emitting the answer | **the specialist itself** |
| LLM calls per request | classify + specialist + relay | classify + specialist |

```yaml
dispatch:
  default_route: "Generalist"          # fail-static target; must be a declared subagent

orchestrator:
  name: "Triage"
  model: "gemini-3.5-flash-lite"
  instruction: |
    Name exactly ONE specialist for this message. ...
  outputSchema:                        # a leaf holding a schema — no subagent tools
    type: "OBJECT"
    properties:
      route:  { type: "STRING", description: "Exact specialist name" }
      reason: { type: "STRING", description: "≤8 plain words for the waiting user" }
    required: ["route"]
  generateContentConfig:
    responseMimeType: "application/json"
```

**Why it exists.** In DELEGATE mode the orchestrator receives the
specialist's answer as a tool response and must re-emit it to close the
turn. That relay is a full LLM call whose only job is copying text it is
forbidden to edit, and it is the least reliable step in the chain — in
production it has finished with zero output tokens (a blank reply) and
emitted the bare tool name in place of a 2,599-character answer.
Plan-dispatch has no relay turn to fail, and the classifier's output
shrinks from a whole relayed answer to ~15 tokens of JSON.

**Why the classifier is tool-less.** ADK refuses to combine
`outputSchema` with AgentTool delegation on one agent (see
`config/agents/examples/critic.yaml` — an orchestrator holding both deadlocks).
That constraint shapes the method: the classifier is a leaf, and the
hand-off happens in code, where it can be logged, traced, and streamed
to the user as progress.

**Sessions.** Every *route* runs in the shared `<contextId>` session, so
one transcript accumulates across routes and long-term memory ingests
real answers instead of a relay copy of them. Sharing the session is
necessary but not sufficient: ADK renders an event by comparing
`event.author` against the agent now running, and under plan-dispatch
every route is its own root agent, so the whole history fails that
comparison and `convertForeignEvent` rewrites it to `role: "user"`
prefixed "For context:". A route reading the raw shared session
therefore receives the thread as one undifferentiated user monologue —
with the previous route's private `thought:` reasoning cloned in as user
speech and raw tool payloads inlined beside it. Routes read the session
through `ProjectedSessionService` (`lib/session/transcript.ts`) instead:
past agent turns are re-authored to the running agent so they survive as
real `role: "model"` turns, labelled `[XScout]` when another desk spoke,
with thoughts and tool traffic dropped. Writes still land on the real
session, which keeps everything.

Both ceilings on that projection are bounds the prompt cannot escape:
40,000 characters of history AND 16 turns, whichever binds first. The turn
cap is not redundant — a thread of short exchanges fits 43 turns inside the
character budget, and 43 turns of history to answer one question is
attention cost no byte budget describes.

The stored row is trimmed on the way out, by `trimEventForStorage`. It has
exactly two readers and neither touches Gemini's opaque `thoughtSignature`
blobs or tool-result payloads: the projection drops thought parts and tool
traffic before any prompt, and the memory service's `serializeEvents` walks
`part.text` alone. Measured across 128 live sessions those two fields were
~90% of every byte stored (`thoughtSignature` alone 73.3%), so they are
stripped from the SERIALIZED COPY — the live in-memory session keeps them,
or the agent's own tool loop breaks mid-turn. An elided tool result keeps
its `id` and `name` and gains a size marker, because ADK pairs calls to
responses by id and throws on a widowed half. 21.72 MB → 4.88 MB; existing
rows shrink retroactively on their next write. Note the constraint this
rests on: dropping the signature is safe only because stored events are
never replayed to a model. The quadratic upload is untouched — `appendEvent`
still rewrites the whole array per event — and is the next lever if row size
returns.

The classifier does not write to that session — its JSON verdicts would
be read as conversation by the next specialist — but it must still SEE
it, or it cannot tell a follow-up from a standalone remark. It runs in a
per-request in-memory session and receives `renderTranscriptDigest`, a
compact both-sides summary of the exchange, above a
`--- MESSAGE TO CLASSIFY ---` marker. It used to get a durable
`<contextId>::route` lane of its own instead, holding only the user's
messages and its own verdicts; that made every rule about follow-ups and
redos unusable, and left holes wherever a `route_overrides` hit skipped
the classifier entirely.

**Fail-static.** Malformed JSON, an unknown route name, an empty
payload, or a classifier that errors outright all resolve to
`default_route` and still answer the user — routing is an optimisation,
answering is the contract. `default_route` must therefore name a
specialist that can handle anything. The whole resolver is pure; the
contract lives in `lib/dispatch.ts`.

**Telemetry.** The chosen route is published as a
`[STATUS] Routed to <Name> — <reason>` progress event before the
specialist runs, so an A2A client can show a waiting user what is
happening. The `reason` field is written for that reader, not for logs.

Implemented in `scripts/a2a_server.ts`; like `yaml_reference`, it is
A2A-only — the CLI runner (`scripts/syndicate_chat.ts`) still compiles
every syndicate in DELEGATE mode.

## 7. Extending the framework

**Call ADK directly (no syndicate)**: the YAML layer is a convenience,
never a requirement. `scripts/direct_call.ts` (`npm run demo:direct`) is
the canonical minimal block — `LlmAgent` + `Runner` +
`InMemorySessionService` straight from `@google/adk`, ~30 lines you can
copy into any repo that has `@google/adk` installed. Add
`registerAvailableProviders()` from `lib/models/registry.ts` and the
same block runs `claude-*` / `gpt-*` / `grok-*` / `ollama/*` ids too.

**Add a syndicate**: create `config/agents/<name>.yaml` — copy the
closest starter-pack file from `config/agents/examples/` or start from
`syndicateSchema.yaml` — then `npm run chat:syndicate -- --syndicate
<name>`. No code changes. The loader checks the root first, then
`examples/`, so your syndicate and the starter pack never collide.

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

**Teach your coding agent the framework**: `skills/` holds six Agent
Skills (the open SKILL.md standard — a directory per skill, `name` and
`description` frontmatter) that give Claude Code, Codex, Cursor,
OpenCode or Gemini CLI the catalog of syndicates and the procedures in
this document: `melchizedek` (find and run, delegate a task),
`melchizedek-author`, `melchizedek-serve`, `melchizedek-memory`,
`melchizedek-models`, `melchizedek-scribe`. `npx melchizedek-skills
install` copies them into `.claude/skills/` and `.agents/skills/` of the
current project (`--for claude,codex,cursor,opencode,gemini,agents,all`,
`--global`, `--dir <path>`, `--only <names>`, `--force`, `--dry-run`;
`npm run skills:install` in a clone). The installer (`lib/skills.ts`)
copies only from the package's own `skills/` directory, follows no
symlinks, and never overwrites a differing file without `--force`. Each
SKILL.md body was written by the Scribe syndicate
(`config/agents/examples/scribe.yaml`) from a brief of facts and reviewed
by a person; `skills/README.md` records the procedure.

## 8. Security notes

- **Secrets** live in `.env` only; `.env.example` documents every
  variable and ships no values (placeholders are ignored if copied in).
  Nothing in the repo ships a key. Report vulnerabilities per SECURITY.md.
- **Database**: default Supabase leaves `public`-schema tables readable
  by the anon key over REST. `db/hardening.sql` enables deny-by-default
  RLS and revokes anon/authenticated privileges on every table it finds:
  `adk_sessions`, `adk_memory_facts`, and — where they exist — the
  optional `adk_telemetry` sink and `adk_agent_registry` (an unprotected
  registry is worst of all: agent definitions writable with the anon key
  means anyone can rewrite the instructions your server boots). The A2A
  server verifies hardening at boot and is fatal on public deployments
  without it. Note `service_role` bypasses RLS by design — the hardening
  constrains the API surface, not the trusted server.
- **A2A**: bearer auth, a failed-login limiter and a request rate limit
  are built in; without `A2A_SERVER_SECRET` the server binds loopback only.
  See §6 for the posture checks at boot.
- **Outbound fetches** (`web_extract`, MCP servers, remote A2A agents) pass
  one SSRF guard (`lib/net/addressGuard.ts`): local names and non-public
  addresses in every encoding are refused, and names are resolved and
  refused when any address is non-public. DNS rebinding between the check
  and the connection is the remaining, stated limit.
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

---

## 9. The knowledge bundle (wiki/)

`wiki/` is this framework's documentation as an **Open Knowledge Format v0.2
bundle** ([spec](https://github.com/GoogleCloudPlatform/knowledge-catalog)):
markdown concept documents with YAML frontmatter (`type` is the only
required key), linked with ordinary bundle-absolute markdown links — and
the links ARE the knowledge graph. `index.md` per directory and the root
`log.md` are reserved, machine-maintained files. Start at
`wiki/meta/wiki-system.md`; the whole bundle renders on GitHub.

The tooling in `lib/wiki/` is **bundle-agnostic** — point `WIKI_ROOT` at any
OKF directory, or scaffold a fresh one with `npm run wiki:init`:

- **Parse & build** (`markdown.ts`, `builder.ts`) — a zero-dependency
  structural engine; documents interleave machine-owned `wiki:generated`
  regions (rebuilt from source-of-truth files), `wiki:fill` prose slots an
  LLM fills once (`lib/wiki/fill.ts`, any provider via the model registry),
  and ordinary prose that rebuilds never touch.
- **Graph** (`graph.ts`) — nodes are documents, edges are resolved links;
  orphans and broken links fall out as queries.
- **Entity graph** (`entities.ts`, `extract.ts`) — a second layer over the
  same files: agents, tools, models, providers, modules, tables and
  environment variables as typed nodes. Structural relations are DERIVED
  from repo truth on every build (zero-dependency scanners for imports,
  `process.env` reads, DDL and npm scripts) into `.graph/graph.json`;
  judgments that only prose carries are ASSERTED with evidence and an actor
  into `.graph/relations.json`, which the build never rewrites.
- **Lint** (`lint.ts`, `npm run wiki:check`) — OKF conformance, link
  integrity, index coverage, staleness, and the private-subtree closure
  rule; errors gate every write.
- **Navigate & garden** (`lib/tools/wikiTools.ts`) — tool contracts (§3
  pattern) in three tiers: navigation (`wiki_map`, `wiki_search`,
  `wiki_read`, `wiki_links`, `wiki_dive` — a "repo dive" returns an ordered
  reading plan for a task — and `wiki_graph`, which answers the relational
  questions documents cannot: who calls this tool, what needs this key, how
  do these two connect), the gated writes (`wiki_save` — lint-validated,
  path-jailed, auto-updates the directory index and `log.md`; `wiki_relate`
  — one evidenced relation, refusing anything the build derives), and
  agentic composites (`wiki_query`, `wiki_garden` — one-shot agents with
  citations and honest actor attribution in frontmatter provenance).

Serving: syndicate agents declare the navigation/write tools by name
(`config/agents/examples/scriptorium.yaml` works the prose,
`config/agents/examples/cartographers.yaml` the graph — `npm run syndicate:scriptorium`,
`npm run syndicate:cartographers`); outside MCP clients get all ten from
`npm run mcp:wiki` (loopback SSE on `:8933`). Trust is explicit in
frontmatter: `generated.by` records who wrote a document (`human:<id>`,
`process:<id>`, or `<producer>/<model>`), and only a `human:` entry in
`verified` makes it human-reviewed.
