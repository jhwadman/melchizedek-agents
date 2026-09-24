/**
 * lib/skills.ts — the agent-skills suite installer, as a library.
 *
 * WHY: the framework ships a suite of Agent Skills (skills/<name>/SKILL.md,
 * the open SKILL.md standard) that teach a coding agent — Claude Code, Codex,
 * Cursor, OpenCode, Gemini CLI — where the syndicates are and how to run,
 * author, serve and remember with them. Each platform reads skills from its
 * own directory; this module knows those directories and copies the suite
 * into them. `scripts/skills_install.ts` (the `melchizedek-skills` bin) is
 * the CLI over it; `tests/skills.test.ts` exercises it against temp dirs.
 *
 * Safety: the source is the package's own skills/ directory (resolved by
 * walking up from this file), symlinks are never followed, and a file that
 * already exists with different content is left alone unless `force` is set.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillTarget = 'claude' | 'agents' | 'codex' | 'cursor' | 'opencode' | 'gemini';

export interface TargetPaths {
  /** Relative to the project root (the directory the agent is opened in). */
  project: string;
  /** Relative to the home directory. */
  global: string;
  /** Which agents read this location. */
  readBy: string;
}

/**
 * Where each coding agent discovers skills. `.agents/skills/` is the shared
 * location Codex, Cursor, OpenCode and Gemini CLI all read, so the default
 * install writes `claude` + `agents` and reaches every listed agent.
 */
export const SKILL_TARGETS: Record<SkillTarget, TargetPaths> = {
  claude: { project: '.claude/skills', global: '.claude/skills', readBy: 'Claude Code (also read by OpenCode)' },
  agents: { project: '.agents/skills', global: '.agents/skills', readBy: 'Codex, Cursor, OpenCode, Gemini CLI' },
  codex: { project: '.agents/skills', global: '.codex/skills', readBy: 'Codex' },
  cursor: { project: '.cursor/skills', global: '.cursor/skills', readBy: 'Cursor' },
  opencode: { project: '.opencode/skills', global: '.config/opencode/skills', readBy: 'OpenCode' },
  gemini: { project: '.gemini/skills', global: '.gemini/skills', readBy: 'Gemini CLI' },
};

export const DEFAULT_TARGETS: SkillTarget[] = ['claude', 'agents'];

/** The package's skills/ directory: walk up from this module until it appears. */
export function resolveSkillsSource(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'skills');
    if (existsSync(join(candidate, 'melchizedek', 'SKILL.md'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('skills/ directory not found beside the package (looked for skills/melchizedek/SKILL.md)');
}

export interface SkillInfo {
  name: string;
  description: string;
  dir: string;
}

/** Every skill in the suite: a directory holding a SKILL.md with name + description frontmatter. */
export function listSkills(source: string = resolveSkillsSource()): SkillInfo[] {
  return readdirSync(source, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(source, d.name, 'SKILL.md')))
    .map((d) => {
      const text = readFileSync(join(source, d.name, 'SKILL.md'), 'utf-8');
      const fm = text.startsWith('---') ? text.slice(3, text.indexOf('\n---', 3)) : '';
      const field = (k: string): string => {
        const m = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
        return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
      };
      return { name: field('name') || d.name, description: field('description'), dir: join(source, d.name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface InstallOptions {
  /** Explicit destination directory; overrides targets/global. */
  dir?: string;
  targets?: SkillTarget[];
  global?: boolean;
  /** Project root for non-global installs (default: cwd). */
  projectRoot?: string;
  /** Home directory for global installs (default: os.homedir()). */
  home?: string;
  /** Skill names to install (default: every skill). */
  only?: string[];
  force?: boolean;
  dryRun?: boolean;
  source?: string;
}

export interface InstallResult {
  destination: string;
  written: string[];
  skipped: string[];
  unchanged: string[];
}

/** Resolve the destination directories an install would write to (deduplicated, in order). */
export function destinationsFor(opts: InstallOptions): string[] {
  if (opts.dir) return [resolve(opts.dir)];
  const targets = opts.targets && opts.targets.length > 0 ? opts.targets : DEFAULT_TARGETS;
  const root = opts.global ? (opts.home ?? homedir()) : resolve(opts.projectRoot ?? process.cwd());
  const out: string[] = [];
  for (const t of targets) {
    const paths = SKILL_TARGETS[t];
    if (!paths) throw new Error(`unknown target "${t}" (known: ${Object.keys(SKILL_TARGETS).join(', ')})`);
    const dest = join(root, opts.global ? paths.global : paths.project);
    if (!out.includes(dest)) out.push(dest);
  }
  return out;
}

function walk(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (lstatSync(full).isSymbolicLink()) continue; // never follow links out of the suite
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

/** Copy the suite into every destination. Returns one result per destination. */
export function installSkills(opts: InstallOptions = {}): InstallResult[] {
  const source = opts.source ?? resolveSkillsSource();
  const skills = listSkills(source).filter((s) => !opts.only || opts.only.includes(s.name));
  if (opts.only) {
    const known = new Set(listSkills(source).map((s) => s.name));
    for (const name of opts.only) if (!known.has(name)) throw new Error(`unknown skill "${name}"`);
  }
  const results: InstallResult[] = [];
  for (const destination of destinationsFor(opts)) {
    const result: InstallResult = { destination, written: [], skipped: [], unchanged: [] };
    for (const skill of skills) {
      const skillDir = skill.dir;
      const destSkillDir = join(destination, relative(dirname(skillDir), skillDir));
      for (const rel of walk(skillDir)) {
        const src = join(skillDir, rel);
        const dst = join(destSkillDir, rel);
        // The destination stays inside the skill's own directory: a hostile
        // filename in the suite could not escape it.
        if (!resolve(dst).startsWith(resolve(destSkillDir))) throw new Error(`refusing to write outside ${destSkillDir}: ${rel}`);
        const label = relative(destination, dst);
        const bytes = readFileSync(src);
        if (existsSync(dst)) {
          if (statSync(dst).isFile() && readFileSync(dst).equals(bytes)) { result.unchanged.push(label); continue; }
          if (!opts.force) { result.skipped.push(label); continue; }
        }
        if (!opts.dryRun) {
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, bytes);
        }
        result.written.push(label);
      }
    }
    results.push(result);
  }
  return results;
}
