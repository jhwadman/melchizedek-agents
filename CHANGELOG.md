# Changelog — melchizedek-agents (the npm package)

Consumers of the package read this file; it records changes to the
**published API surface** (the exports map in `package.json`, the two
bins, and the starter pack), not the repo's full history.

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
