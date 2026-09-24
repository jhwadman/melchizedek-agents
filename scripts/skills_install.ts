#!/usr/bin/env node
/**
 * scripts/skills_install.ts — the `melchizedek-skills` bin.
 *
 * Installs the framework's Agent Skills suite (skills/<name>/SKILL.md) into
 * the directories coding agents read skills from, so Claude Code, Codex,
 * Cursor, OpenCode or Gemini CLI can find the syndicates and know how to run,
 * author, serve and remember with them.
 *
 *   melchizedek-skills list                 # the skills in the suite
 *   melchizedek-skills paths                # where each target reads skills
 *   melchizedek-skills install              # → .claude/skills + .agents/skills in this project
 *   melchizedek-skills install --for cursor,opencode
 *   melchizedek-skills install --for all --global
 *   melchizedek-skills install --dir ./some/skills/dir
 *   melchizedek-skills install --only melchizedek,melchizedek-scribe
 *   melchizedek-skills install --force      # overwrite files that differ
 *   melchizedek-skills install --dry-run
 *
 * Clone equivalent: npm run skills:install -- <same flags>.
 * Nothing is read from the network; nothing is written outside the chosen
 * skills directories.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_TARGETS,
  SKILL_TARGETS,
  destinationsFor,
  installSkills,
  listSkills,
  type InstallOptions,
  type SkillTarget,
} from '../lib/skills.ts';

const USAGE = `melchizedek-skills — install the Melchizedek agent-skills suite into your coding agent

  melchizedek-skills list
  melchizedek-skills paths
  melchizedek-skills install [--for <targets>] [--global] [--dir <path>] [--only <skills>] [--force] [--dry-run]

  --for      comma list of: ${Object.keys(SKILL_TARGETS).join(', ')}, all   (default: ${DEFAULT_TARGETS.join(',')})
  --global   write to the home-directory locations instead of this project's
  --dir      write to one explicit directory (overrides --for / --global)
  --only     comma list of skill names (default: every skill)
  --force    overwrite a file that exists with different content
  --dry-run  print what would be written, write nothing
`;

export function parseArgs(argv: string[]): { command: string; opts: InstallOptions } {
  const [command = 'help', ...rest] = argv.filter((a) => a !== '--');
  const opts: InstallOptions = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const next = (): string => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--for') {
      const list = next().split(',').map((s) => s.trim()).filter(Boolean);
      opts.targets = list.includes('all') ? (Object.keys(SKILL_TARGETS) as SkillTarget[]) : (list as SkillTarget[]);
    } else if (a === '--global' || a === '-g') opts.global = true;
    else if (a === '--dir') opts.dir = next();
    else if (a === '--only') opts.only = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '-h' || a === '--help') return { command: 'help', opts };
    else throw new Error(`unknown flag ${a}`);
  }
  return { command, opts };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { command, opts } = parsed;

  if (command === 'help') {
    console.log(USAGE);
    return 0;
  }
  if (command === 'list') {
    for (const s of listSkills()) console.log(`${s.name.padEnd(22)} ${s.description}`);
    return 0;
  }
  if (command === 'paths') {
    console.log(`target      project location          global location                  read by`);
    for (const [t, p] of Object.entries(SKILL_TARGETS)) {
      console.log(`${t.padEnd(11)} ${p.project.padEnd(25)} ~/${p.global.padEnd(30)} ${p.readBy}`);
    }
    console.log(`\ndefault: --for ${DEFAULT_TARGETS.join(',')}`);
    return 0;
  }
  if (command !== 'install') {
    console.error(`✗ unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }

  let results;
  try {
    results = installSkills(opts);
  } catch (err) {
    console.error(`✗ ${(err as Error).message}`);
    return 1;
  }
  const verb = opts.dryRun ? 'would write' : 'wrote';
  for (const r of results) {
    console.log(`${opts.dryRun ? '○' : '✓'} ${r.destination}`);
    console.log(`    ${verb} ${r.written.length} file(s), ${r.unchanged.length} unchanged, ${r.skipped.length} skipped`);
    for (const f of r.written) console.log(`    + ${f}`);
    for (const f of r.skipped) console.log(`    ! ${f} exists with different content (use --force to overwrite)`);
  }
  if (!opts.dir) {
    const sample = destinationsFor(opts);
    console.log(`\nOpen your coding agent in ${opts.global ? 'any project' : 'this project'} and ask it about a Melchizedek syndicate; the skills load from ${sample.map((d) => d).join(' and ')}.`);
  }
  return results.some((r) => r.skipped.length > 0) ? 3 : 0;
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
}

if (isMain()) process.exit(main());
