# Melchizedek agent skills

## What this is

This directory contains a suite of six Agent Skills built to the open SKILL.md standard: one directory per skill, a SKILL.md file with `name` and `description` frontmatter, and optional supporting files. The skills teach a coding agent how to find, run, author, serve, remember with, and write with Melchizedek syndicates. They ship in the npm package melchizedek-agents and in the public repository, inside `skills/`.

## The skills

- `melchizedek`: The entry point. Teaches where the syndicates are, what each starter-pack file does and costs, the doctor, running one interactively or one shot, and delegating a task from a coding agent.
- `melchizedek-author`: Teaches designing or editing a syndicate YAML: layout, keys, instruction anatomy, tools by name, the two constraints that break a file, and offline validation.
- `melchizedek-serve`: Teaches the A2A server, securing and calling it, MCP tools for a subagent, and serving your own tools over MCP.
- `melchizedek-memory`: Teaches Supabase sessions and long-term memory: modes, schema, tools, extraction rules, inspection, and erasure.
- `melchizedek-models`: Teaches model ids and providers, keys, keyless Ollama, the gateway fallback, per-agent settings, and the errors.
- `melchizedek-scribe`: Teaches writing documents from a brief with the Scribe syndicate.

## Install

Install the skills using any of three methods.

Install from the package into this project's `.claude/skills/` and `.agents/skills/`:

```bash
npm install melchizedek-agents
npx melchizedek-skills install
```

Between them, `.claude/skills/` and `.agents/skills/` reach Claude Code, Codex, Cursor, OpenCode, and Gemini CLI. In a clone of the repository, run the install script (flags after `--`):

```bash
npm run skills:install -- --for all
```

The command accepts these flags:
- `--for <targets>` picks platforms from `claude, agents, codex, cursor, opencode, gemini, all`.
- `--global` writes the home-directory locations instead.
- `--dir <path>` writes one explicit directory.
- `--only <names>` installs a subset.
- `--force` overwrites a file that differs.
- `--dry-run` prints without writing.

You can inspect target paths and available skills:

```bash
npx melchizedek-skills paths
npx melchizedek-skills list
```

The installer copies files from the package's own `skills/` directory, follows no symlinks, writes nothing outside the chosen directories, and leaves a file that already exists with different content alone unless you pass `--force`.

Install with the skills CLI from the public repository:

```bash
npx skills add jhwadman/melchizedek-agents
```

This command lists the skills and installs the chosen skills into the chosen agents.

Install by hand by copying any `skills/<name>/` directory into a target location listed below.

## Where each agent reads skills

| Agent | Project location | Global location |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` | `~/.codex/skills/` (also `~/.agents/skills/`) |
| Cursor | `.cursor/skills/` or `.agents/skills/` | `~/.cursor/skills/` or `~/.agents/skills/` |
| OpenCode | `.opencode/skills/`, `.claude/skills/` or `.agents/skills/` | `~/.config/opencode/skills/`, `~/.claude/skills/` or `~/.agents/skills/` |
| Gemini CLI | `.gemini/skills/` or `.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` |

## How the prose was written

The Scribe syndicate (`config/agents/examples/scribe.yaml`, a Gemini agent that writes a document from a technical brief and audits it against the brief) wrote each SKILL.md body from one brief per skill. A person then reviewed each file. The briefs carry the facts; the Scribe carries the voice. To change a skill, change the facts and rerun with the melchizedek-scribe skill.

The suite shares the MIT license of the package.
