# Changelog — melchizedek-agents (the npm package)

Consumers of the package read this file; it records changes to the
**published API surface** (the exports map in `package.json`, the two
bins, and the starter pack), not the repo's full history.

## 0.13.0 — 2026-09-24

- **`melchizedek-skills`: the framework as a skills suite.** A fourth bin
  (and `npm run skills:install`) copies `skills/` — six Agent Skills in the
  open SKILL.md standard — into the directories coding agents read:
  `.claude/skills/` and `.agents/skills/` by default (between them, Claude
  Code, Codex, Cursor, OpenCode and Gemini CLI), or `--for
  claude,codex,cursor,opencode,gemini,agents,all`, `--global`, `--dir`,
  `--only`, `--force`, `--dry-run`; `list` and `paths` subcommands. The
  suite: `melchizedek` (where the syndicates are, what each costs, run one,
  delegate a task from a coding agent), `melchizedek-author`,
  `melchizedek-serve`, `melchizedek-memory`, `melchizedek-models`,
  `melchizedek-scribe`. `skills` joins `files`; engine: `lib/skills.ts`.
- **Starter pack: `scribe.yaml`, The Scribe.** A Gemini syndicate that
  writes one document from a technical brief and audits it against the
  brief through a JSON-schema leaf (the Auditor) before returning it.
  `npm run syndicate:scribe`. The skills suite above was written with it,
  one brief per skill.

## 0.12.0 — 2026-09-23

- **`melchizedek-doctor`: which keys do I need?** A third bin (and
  `npm run doctor`) reads every syndicate YAML the loader can see, resolves
  each agent's model to its provider under the current `.env`, and prints
  one table — agent, model, provider, which declared server-side tools the
  path keeps or drops, and whether the path is funded — with one verdict
  per syndicate and the variables that would unlock the most. Read-only:
  nothing is sent, nothing is written, no key value is printed. `--json`,
  `--check`. Engine: `lib/doctor.ts`.
- **The gateway fallback (`lib/models/gatewayLlm.ts`, `lib/models/gateway.ts`).**
  `MODEL_GATEWAY=vercel|openrouter` + `MODEL_GATEWAY_API_KEY` serve any
  cloud model id whose direct key is ABSENT through that gateway's
  OpenAI-compatible endpoint. Direct adapters stay canonical: a present
  provider key always wins, Ollama never routes through a gateway, and a
  BYOK `X-API-Key` on the A2A server never selects it. Attribution stays
  with the upstream provider (`llm.provider`); the transport is recorded
  separately (`llm.transport = gateway:<id>`). Optional dials:
  `MODEL_GATEWAY_BASE_URL` (self-hosted proxy), `MODEL_GATEWAY_MODEL_MAP`
  (wire-name overrides). `registerAvailableProviders()` registers the
  stand-in for uncovered providers; `providerStatuses()` gains
  `transport` and `gateway`; `resolveModel()` applies the same rule.
- **Capability report (`lib/models/capabilities.ts`).** `describeCapabilities`
  states, per agent and on the RESOLVED path, which server-side tool
  sentinels (`web_search`, `google_search`, `x_search`,
  `collections_search`) run natively and which are dropped. The compiler
  logs one `capability ·` line per affected agent; the chat-completions
  base records `llm.transport` and `llm.capability.dropped` on the span.
  New exports from the package root: `describeCapabilities`,
  `capabilitySummary`, `planTransport`, `gatewayConfig`, `gatewayProblem`,
  `gatewayUsable`, `GATEWAYS`, `GatewayLlm`.
- **Starter pack: `# tier:` headers.** Every example opens with `keyless`,
  a single provider (`gemini`, `anthropic`), or `multi-provider`; the
  doctor checks the claim against the models.

## 0.11.0 — 2026-09-20

- **`x_api_search`: the X channel without a Grok dependency.** A new
  client-side tool (`lib/tools/xApiSearchTool.ts`, registered in
  `TOOL_MAP`) searches X's last seven days through the X API v2 recent
  search and transcribes every PHOTO attached to a post through a Gemini
  vision pass, pasted beneath the post. It runs on any provider and needs
  `X_BEARER_TOKEN` (a read-only app token) plus the Gemini key the engine
  already uses; without the token it reports itself unavailable to the
  agent instead of failing the turn. The starter pack's `augustin.yaml`
  moves its XResearcher onto it (`gemini-3.8-flash` + `x_api_search` +
  `web_extract`), so the fact-checking arbiter no longer requires
  `XAI_API_KEY`. `x_search` stays registered for grok-* agents that want
  xAI's semantic ranker. Dials, all environment: `X_API_IMAGE_MAX`
  (photos read per page, default 8), `X_API_MAX_RESULTS` (page ceiling,
  default 50), `X_API_VISION_MODEL` (default `gemini-3.8-flash`).

## 0.10.0 — 2026-09-09

- **Post-answer guards.** A syndicate YAML may now carry an optional
  `guards:` list of guard NAMES, run after the answering turn and before
  the reply is published. A guard receives the final text plus every
  tool-result text of that turn and returns the text to ship along with
  notes for the `[STATUS]` stream; it rewrites in place rather than
  re-asking the model. Three shape changes to the published surface:

  - `SyndicateYamlConfig` (`./loadSyndicate`) gains `guards?: string[]`.
    Optional, so every existing config still typechecks.
  - `./loadSyndicate` gains `collectGuards(config, loadNested?)`, which
    returns the union of guard names declared by a syndicate **and by
    every syndicate it nests through `yaml_reference:`**. Read guards
    with this rather than off `config.guards`: a guard belongs to the
    syndicate that declared it, not to the position it occupies in a
    graph, and reading the top-level field alone silently dropped a
    nested syndicate's guards.
  - A new `lib/guards/index.ts` publishes the `Guard` / `GuardResult`
    interfaces and `resolveGuards(names, onUnknown?)`. The registry ships
    EMPTY — the guards this deployment runs are domain modules that stay
    private, the same arrangement `lib/toolRegistry.ts` uses. Register
    your own by adding it to that file's `GUARD_MAP`; an unregistered
    name warns and is skipped rather than failing the run.

  `config/agents/syndicateSchema.yaml` documents the field. No bin
  changes; no existing export changes shape.

- **`lib/tools/mcpServe.ts` (new, internal).** The express/SSE scaffold
  behind `npm run mcp:wiki` — `serveContracts({ name, label, port,
  contracts })` — extracted from three byte-identical copies that had
  begun to drift on error signalling and on whether they read `.env`.
  Not in the exports map and not a bin, but it now ships because
  `scripts/wiki/mcp_server.ts` imports it. Behaviour change for MCP
  clients: a failed tool call is returned with the spec's `isError`
  flag set instead of as an ordinary successful result, so a client can
  tell "the tool answered" from "the tool failed".

## 0.9.6 — 2026-09-02

- **`web_extract` joins the public tool registry.** The tool's source
  (`lib/tools/webExtractTool.ts`) has shipped in the package since
  2026-08-09, but the sanitized `lib/toolRegistry.ts` never mapped the
  YAML name, so `augustin.yaml`'s two researchers logged an unknown-tool
  warning and ruled from search snippets. Declaring `web_extract` in a
  syndicate now resolves to the client-side page reader on every
  provider, local Ollama included. Additive: no export, bin, or starter
  file changes shape.

## 0.9.5 — 2026-09-02

- **The default production Gemini is now `gemini-3.8-flash`.** Two
  exported constants change VALUE (not shape): `MEMORY_EXTRACTION_MODEL`
  and `WIKI_AGENT_MODEL` in `lib/config.ts`, plus the internal
  `VISION_MODEL` behind `inspect_image`. Every starter-pack syndicate
  that shipped on `gemini-3.7-flash` now ships on `gemini-3.8-flash`.
  The cheap tier is untouched: `DEFAULT_GEMINI_MODEL` stays
  `gemini-3.1-flash-lite`, and `ares` / `model_zoo` keep their flash-lite
  pins. Nothing in the exports map or the two bins changes.

  The id was verified against the live endpoint before pinning:
  `models/gemini-3.8-flash` publishes exactly 3.7's envelope —
  1,048,576 input, 65,536 output, `thinking: true`, identical
  `supportedGenerationMethods` — so no `maxOutputTokens` in any shipped
  YAML changes and none is an over-ask.

  If you pin a model explicitly in your own YAML, nothing changes for
  you. If you rely on the defaults and want the old behaviour, set
  `WIKI_AGENT_MODEL=gemini-3.7-flash` (env) or pin `model:` in your
  syndicate.

## 0.9.4 — 2026-09-02

- **Thinking and replies stream live.** The OpenAI-compatible adapter
  (Ollama, xAI) now honours ADK's `stream` flag instead of ignoring it:
  it sends `stream: true`, parses the SSE frames, and yields each
  reasoning and text delta as a display-only partial. `melchizedek-chat`
  runs with `streamingMode: SSE`, so a local qwen3 turn shows its
  scratchpad token by token from ~1.5s rather than dumping the whole
  turn after ~15s. `CHAT_STREAMING=false` restores one-block output —
  useful when piping a transcript or for structured-output agents.
  Reasoning is read from a discrete `reasoning` / `reasoning_content`
  delta field where the provider sends one (Ollama does), and otherwise
  from inline `<think>` tags via a new exported `ThinkStreamSplitter`,
  which tracks block state across frames so a tag split mid-delta
  ("<thi" + "nk>") is not mistaken for reply text.
- **Fix: a streamed Claude turn no longer vanishes from session
  history.** ADK's runner persists only NON-partial events, and the
  Claude streaming path built its final response with the text omitted,
  so a reply would render on screen and leave no record — the next turn
  saw no assistant message. The final response now carries the full
  text; printers skip text on a `turnComplete` event whose partials they
  already rendered. This path was unreachable before this release, since
  nothing requested SSE.
- **Chat is silent about telemetry.** `melchizedek-chat` and every
  `syndicate:*` script no longer print `[OTEL_SPAN_JSON]` lines; set
  `OTEL_CONSOLE_SPANS=true` (shell or `.env`) to see them, and
  `OTEL_CONSOLE_SPANS=false` to silence them in other scripts. In-process
  span listeners and the Supabase sink are unaffected either way, so no
  telemetry is lost.

## 0.9.3 — 2026-08-22

- **`outputSchema` is enforced on every provider, not just Gemini** —
  the Claude adapter now carries an agent's `outputSchema` as a forced
  tool call (`tool_choice` on a synthetic `structured_output` tool whose
  `input_schema` is the schema) and turns the validated `tool_use` block
  back into JSON text, so the keys arrive as declared instead of drifting
  (`"grade"` for `"correctness"`); the OpenAI adapter sends
  `json_schema` with `strict: true` over a schema where every object
  forbids extra properties and requires all of its own
  (`toStrictJsonSchema`), which the API previously rejected; the
  OpenAI-compatible adapter (xAI) does the same, while Ollama keeps
  `json_object`. Anything that reads structured fields by name — critic
  loops, plan-dispatch routers on non-Gemini models, LLM judges — now
  works across providers.
- **Engine additions behind the A2A server**: the shared YAML→ADK compiler
  (`lib/compile.ts`), provenance stamps (`lib/observability/lineage.ts`),
  embeddings (`lib/observability/embeddings.ts`), the three-tier
  observability ledger in `db/telemetry.sql` with identity and
  provenance on every span, and `scripts/telemetry_admin.ts`. New
  optional dependency `@opentelemetry/exporter-trace-otlp-http` for
  `OTEL_EXPORTER_OTLP_ENDPOINT`.

## 0.9.2 — 2026-08-20

- **The starter pack gains Augustin** —
  `config/agents/examples/augustin.yaml`, a fact-checking arbiter of
  world events: a grok X-sweep researcher and a Gemini web-verification
  researcher under a tool-free Arbiter that writes a conversational
  lead plus sourced bullet facts. Multi-provider (needs `XAI_API_KEY`
  and `GOOGLE_GENAI_API_KEY`); `npm run syndicate:augustin` in a clone.
  The pattern is taught as a standalone lesson in the curriculum.

## 0.9.1 — 2026-08-19

- **Fix: `melchizedek-serve` actually starts.** The run-as-main guard
  compared `import.meta.url` to argv[1] literally; through the npm bin
  symlink they never match, so the 0.9.0 bin imported everything and
  exited silently. The guard now realpaths argv[1]. `melchizedek-chat`
  was unaffected.
- `melchizedek-serve` without an argument now explains itself when no
  `syndicate.yaml` exists (name your syndicate: `melchizedek-serve
  <name>.yaml`) instead of failing with a bare ENOENT.
- QUICKSTART gains §7, the package-consumer path (docs ship in the
  tarball, so they ride this release).

## 0.9.0 — 2026-08-19

First packaged release (pre-1.0: the API may still move; 1.0.0 lands
after the first external consumer migration).

- The engine is installable: `npm install melchizedek-agents` ships
  compiled JS + type declarations for `lib/` (`loadSyndicate`, the model
  registry, the tool registry, memory/session/persistence/observability,
  the wiki engine) behind an explicit subpath exports map.
- `loadSyndicate` accepts `agentsDir` (or the `MELCHIZEDEK_AGENTS_DIR`
  env var) so your syndicates live in **your** repo; default remains
  `<cwd>/config/agents`. The path jail applies relative to whichever
  root is configured.
- Two bins: `melchizedek-serve` (the A2A server) and `melchizedek-chat`
  (the interactive syndicate CLI).
- The starter pack ships in the package: `config/agents/examples/*.yaml`
  plus `syndicateSchema.yaml` — copy them out, they are teaching
  material, not wiring.
- `@google/adk` is a peer dependency: your app owns the ADK version.
