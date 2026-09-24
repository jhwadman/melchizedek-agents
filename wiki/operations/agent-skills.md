---
type: runbook
title: The agent-skills suite
description: Six Agent Skills (skills/, the open SKILL.md standard) that teach a coding agent where the syndicates are and how to run, author, serve, remember and write with them — how they install, where each platform reads them, and how their prose is regenerated from briefs by the Scribe.
tags:
  - operations
  - skills
  - packaging
generated:
  by: claude-code/claude-fable-5-1
  at: 2026-09-24
sources:
  - resource: skills/README.md
  - resource: lib/skills.ts
  - resource: scripts/skills_install.ts
  - resource: config/agents/examples/scribe.yaml
---

# The agent-skills suite

`skills/` is how a coding agent — Claude Code, Codex, Cursor, OpenCode, Gemini CLI — learns this framework. It holds six Agent Skills in the open SKILL.md standard (one directory per skill, `name` + `description` frontmatter, optional `templates/`), shipped in the npm package (`files` in the overlay manifest) and in the public mirror. They are the consumer-facing counterpart of the private discipline skills in `.claude/skills/`, which govern changes to this repo and never export.

| Skill | Teaches |
|---|---|
| `melchizedek` | the entry point: where syndicate files are found (project root, `examples/`, the package), what each starter-pack file does and costs, `melchizedek-doctor`, running one interactively or one shot, and delegating a user's task to a syndicate from inside a coding agent |
| `melchizedek-author` | the syndicate YAML: layout, keys, instruction anatomy, tools by name, the two constraints that break a file, offline validation; ships `templates/minimal.yaml` |
| `melchizedek-serve` | the [A2A server](/protocols/a2a.md), securing and calling it, [MCP](/protocols/mcp.md) tools for a subagent, serving your own tools over MCP |
| `melchizedek-memory` | [long-term memory](/memory/architecture.md): modes, the [schema](/memory/schema.md), tools, extraction rules, inspection, erasure |
| `melchizedek-models` | [provider routing](/models/provider-routing.md), keys, keyless Ollama, the gateway fallback, per-agent settings, the errors |
| `melchizedek-scribe` | writing documents from a brief with [the Scribe](/agents/scribe.md); ships `templates/brief.md` |

## Installing

`npx melchizedek-skills install` (`npm run skills:install` in a clone; engine `lib/skills.ts`, bin `scripts/skills_install.ts`) copies the suite into the directories agents read. The default writes two: `.claude/skills/` (Claude Code; OpenCode reads it too) and `.agents/skills/` (Codex, Cursor, OpenCode and Gemini CLI all read it), which between them reach every listed agent. `--for claude,codex,cursor,opencode,gemini,agents,all` selects platform-specific locations (`.cursor/skills`, `.opencode/skills` with global `~/.config/opencode/skills`, `.gemini/skills`, Codex's global `~/.codex/skills`); `--global` writes the home-directory locations; `--dir` one explicit directory; `--only` a subset; `--dry-run` prints. `list` and `paths` subcommands describe the suite and the locations. `npx skills add jhwadman/melchizedek-agents` (the skills CLI) installs from the public repo without the package.

The installer copies only from the package's own `skills/` directory (found by walking up from the module, so it works from source and from `dist/`), follows no symlinks, refuses to write outside a skill's own destination directory, and leaves a file that exists with different content alone unless `--force` is given. `tests/skills.test.ts` covers it offline.

## How the prose is made

Every SKILL.md body and `skills/README.md` were written by [the Scribe](/agents/scribe.md) from one brief each, kept beside the prose in `skills/briefs/`: `_shared.md` (the facts every skill agrees on, and the global limits for a skill file) is prepended to each skill's brief; the brief carries the facts, identifiers and required structure; the Scribe carries the voice; a person reviews the result. A skill changes by changing its brief and rerunning (`CHAT_STREAMING=false npm run syndicate:scribe -- "$(cat brief)"`, the document is everything after the last `Scribe › ` line), never by patching prose with the brief left stale — the `melchizedek-scribe` skill is that procedure. The [export pipeline](/operations/export-pipeline.md) lists every skill file and brief in its allowlist; a new skill is a deliberate publication. Rationale: [ADR 0014](/decisions/0014-agent-skills-suite.md).
