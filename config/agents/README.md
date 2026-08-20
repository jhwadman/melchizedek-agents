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

The loader (`lib/loadSyndicate.ts`) resolves a bare filename against the
root first, then `examples/`, so `npm run syndicate:tutor` and friends keep
working, and promoting an example to production is just moving it one
level up.
