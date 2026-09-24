AUDIENCE: a software engineer reading the skills/ directory of the melchizedek-agents package or repository on GitHub.
KIND: a README for the skills/ directory.
PURPOSE: the reader knows what the suite is, what each skill does, and installs it into their coding agent with one command.

STRUCTURE (exact): an H1 `# Melchizedek agent skills`, then `##` sections in this order: "What this is", "The skills", "Install", "Where each agent reads skills", "How the prose was written".

FACTS:
What this is:
- A suite of six Agent Skills (the open SKILL.md standard: one directory per skill, a SKILL.md with `name` and `description` frontmatter, optional supporting files) that teach a coding agent how to find, run, author, serve, remember with, and write with Melchizedek syndicates. They ship in the npm package melchizedek-agents and in the public repository, in `skills/`.
The skills (name → what it teaches):
- `melchizedek` → the entry point: where the syndicates are, what each starter-pack file does and costs, the doctor, running one interactively or one shot, and delegating a task from a coding agent.
- `melchizedek-author` → designing or editing a syndicate YAML: layout, keys, instruction anatomy, tools by name, the two constraints that break a file, offline validation.
- `melchizedek-serve` → the A2A server, securing and calling it, MCP tools for a subagent, serving your own tools over MCP.
- `melchizedek-memory` → Supabase sessions and long-term memory: modes, schema, tools, extraction rules, inspection, erasure.
- `melchizedek-models` → model ids and providers, keys, keyless Ollama, the gateway fallback, per-agent settings, the errors.
- `melchizedek-scribe` → writing documents from a brief with the Scribe syndicate.
Install (three ways):
- From the package, into this project's `.claude/skills/` and `.agents/skills/` (the two locations that between them reach Claude Code, Codex, Cursor, OpenCode and Gemini CLI): `npx melchizedek-skills install` after `npm install melchizedek-agents`. `--for <targets>` picks platforms from `claude, agents, codex, cursor, opencode, gemini, all`; `--global` writes the home-directory locations instead; `--dir <path>` writes one explicit directory; `--only <names>` installs a subset; `--force` overwrites a file that differs; `--dry-run` prints without writing. `npx melchizedek-skills paths` prints the locations; `npx melchizedek-skills list` prints the skills. In a clone: `npm run skills:install -- <same flags>`.
- With the skills CLI from the public repository: `npx skills add jhwadman/melchizedek-agents` lists the skills and installs the ones you choose into the agents you choose.
- By hand: copy any `skills/<name>/` directory into a location from the table below.
- The installer copies files from the package's own `skills/` directory, follows no symlinks, writes nothing outside the chosen directories, and leaves a file that already exists with different content alone unless `--force` is given.
Where each agent reads skills (project location; global location):
- Claude Code: `.claude/skills/`; `~/.claude/skills/`
- Codex: `.agents/skills/`; `~/.codex/skills/` (also `~/.agents/skills/`)
- Cursor: `.cursor/skills/` or `.agents/skills/`; `~/.cursor/skills/` or `~/.agents/skills/`
- OpenCode: `.opencode/skills/`, `.claude/skills/` or `.agents/skills/`; `~/.config/opencode/skills/`, `~/.claude/skills/` or `~/.agents/skills/`
- Gemini CLI: `.gemini/skills/` or `.agents/skills/`; `~/.gemini/skills/` or `~/.agents/skills/`
How the prose was written:
- Each SKILL.md body was written by the Scribe syndicate (`config/agents/examples/scribe.yaml`, a Gemini agent that writes a document from a technical brief and audits it against the brief) from one brief per skill, then reviewed by a person. The briefs carry the facts; the Scribe carries the voice. To change a skill, change the facts and rerun (the melchizedek-scribe skill).
- License: MIT, with the package.

IDENTIFIERS (verbatim): skills/, melchizedek-agents, npx melchizedek-skills install, --for, --global, --dir, --only, --force, --dry-run, npx melchizedek-skills paths, npx melchizedek-skills list, npm run skills:install, npx skills add jhwadman/melchizedek-agents, .claude/skills/, .agents/skills/, .cursor/skills/, .opencode/skills/, .gemini/skills/, ~/.codex/skills/, ~/.config/opencode/skills/, config/agents/examples/scribe.yaml
LIMITS: under 110 lines. The skills and the locations are lists or a table. Commands in fenced bash blocks.
