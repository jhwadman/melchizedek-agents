/**
 * lib/wiki/extract.ts — zero-dependency scanners that read structure out of source.
 *
 * WHY this file exists:
 *   The entity graph (lib/wiki/entities.ts) is only worth having if its
 *   extracted tier is cheap and honest. These are the readers that make it
 *   so: import edges, environment reads, table definitions and mentions,
 *   pulled straight out of file text with regexes and no parser
 *   dependency — the same judgment as the markdown engine
 *   (wiki/decisions/0002): at this scale a careful scanner beats a
 *   toolchain, and rebuild-from-source beats a cached index.
 *
 *   They are deliberately CONSERVATIVE. A regex cannot see a dynamic
 *   import built from a variable, or a table name assembled at runtime;
 *   what it does report, it read verbatim. Nothing here guesses, so an
 *   extracted edge always has a literal line of source behind it.
 *
 *   Bundle-agnostic and repo-agnostic: callers hand in text and paths.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

// ── File walking ─────────────────────────────────────────────────────────────

export interface WalkOptions {
  /** Only files whose name ends with one of these. */
  extensions?: string[];
  /** Directory names skipped wherever they appear. */
  skipDirs?: string[];
}

const DEFAULT_SKIP = ['node_modules', 'dist', 'build', 'coverage', 'outputs'];

/** Repo-relative POSIX paths under `dir`, sorted, dotfiles skipped. */
export function walkFiles(root: string, dir: string, options: WalkOptions = {}): string[] {
  const skip = new Set([...DEFAULT_SKIP, ...(options.skipDirs ?? [])]);
  const out: string[] = [];
  const visit = (absDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(join(absDir, entry.name));
      } else if (entry.isFile()) {
        if (
          options.extensions &&
          !options.extensions.some((ext) => entry.name.endsWith(ext))
        ) {
          continue;
        }
        out.push(relative(root, join(absDir, entry.name)).split(sep).join('/'));
      }
    }
  };
  try {
    if (statSync(dir).isDirectory()) visit(dir);
  } catch {
    return [];
  }
  return out.sort();
}

// ── Source modules ───────────────────────────────────────────────────────────

export interface ModuleScan {
  /** Import specifiers exactly as written. */
  specifiers: string[];
  /** Repo-relative paths of the local modules imported. */
  localImports: string[];
  /** Bare package names imported (first path segment, scope-aware). */
  packages: string[];
  /** Environment variables the module reads. */
  envVars: string[];
}

/**
 * `from '<specifier>'` covers every static import and re-export, however
 * many lines the binding list spans; a bare side-effect import and a
 * literal dynamic import are matched separately. Deliberately literal: a
 * specifier assembled from a variable is invisible here, and stays so.
 */
const FROM_RE = /\bfrom\s+['"]([^'"\n]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s+['"]([^'"\n]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const ENV_DOT_RE = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g;
const ENV_INDEX_RE = /process\.env\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;

/** Resolve a relative specifier against the importing file's repo path. */
export function resolveLocalImport(fromRelPath: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const resolved = posix.normalize(posix.join(posix.dirname(fromRelPath), specifier));
  return resolved.startsWith('..') ? null : resolved;
}

function packageName(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('node:')) return specifier;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function scanModule(text: string, relPath: string): ModuleScan {
  const specifiers = new Set<string>();
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) specifiers.add(match[1]);
  }
  const envVars = new Set<string>();
  for (const re of [ENV_DOT_RE, ENV_INDEX_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) envVars.add(match[1]);
  }

  const localImports = new Set<string>();
  const packages = new Set<string>();
  for (const specifier of specifiers) {
    const local = resolveLocalImport(relPath, specifier);
    if (local) {
      // A file cannot import itself; a match on its own path came from a
      // usage example in a comment, which is documentation, not an edge.
      if (local !== relPath) localImports.add(local);
      continue;
    }
    const pkg = packageName(specifier);
    if (pkg) packages.add(pkg);
  }

  return {
    specifiers: [...specifiers].sort(),
    localImports: [...localImports].sort(),
    packages: [...packages].sort(),
    envVars: [...envVars].sort(),
  };
}

// ── SQL ──────────────────────────────────────────────────────────────────────

export interface SqlScan {
  /** Tables this DDL creates. */
  defined: string[];
  /** Tables it alters or references without creating. */
  referenced: string[];
}

const CREATE_TABLE_RE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:(?:"[^"]+"|[a-z0-9_]+)\.)?("?[a-z0-9_]+"?)/gi;
const ALTER_TABLE_RE =
  /alter\s+table\s+(?:if\s+exists\s+)?(?:(?:"[^"]+"|[a-z0-9_]+)\.)?("?[a-z0-9_]+"?)/gi;
const REFERENCES_RE = /references\s+(?:(?:"[^"]+"|[a-z0-9_]+)\.)?("?[a-z0-9_]+"?)/gi;

function unquote(name: string): string {
  return name.replace(/^"|"$/g, '');
}

export function scanSql(sql: string): SqlScan {
  const defined = new Set<string>();
  const referenced = new Set<string>();
  const collect = (re: RegExp, into: Set<string>): void => {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(sql)) !== null) into.add(unquote(match[1]));
  };
  collect(CREATE_TABLE_RE, defined);
  collect(ALTER_TABLE_RE, referenced);
  collect(REFERENCES_RE, referenced);
  for (const name of defined) referenced.delete(name);
  return { defined: [...defined].sort(), referenced: [...referenced].sort() };
}

/**
 * Which known tables a source file ADDRESSES — matched only as a quoted
 * literal, which is how every client library names a table:
 * `.from(<quoted name>)`. A bare word is deliberately not enough, because
 * prose in a comment mentions table names constantly, and an edge saying
 * "this module touches that table" must mean it.
 */
export function tableMentions(text: string, tables: readonly string[]): string[] {
  const found = new Set<string>();
  for (const table of tables) {
    if (new RegExp(`['"\`]${table}['"\`]`).test(text)) found.add(table);
  }
  return [...found].sort();
}

// ── npm scripts ──────────────────────────────────────────────────────────────

export interface ScriptScan {
  name: string;
  command: string;
  /** Repo-relative source file the script executes, when one is named. */
  entry: string | null;
  /** Long-form flag values, e.g. { syndicate: 'critic' }. */
  flags: Record<string, string>;
}

const ENTRY_RE = /(?:^|\s)((?:scripts|lib|tests|demo)\/[\w./-]+\.(?:ts|mjs|js))/;
const FLAG_RE = /--([a-z][\w-]*)\s+([^\s]+)/g;

export function scanNpmScripts(scripts: Record<string, string>): ScriptScan[] {
  return Object.entries(scripts).map(([name, command]) => {
    const entry = ENTRY_RE.exec(command)?.[1] ?? null;
    const flags: Record<string, string> = {};
    FLAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FLAG_RE.exec(command)) !== null) {
      if (!match[2].startsWith('-')) flags[match[1]] = match[2];
    }
    return { name, command, entry, flags };
  });
}

// ── Object-literal keys ──────────────────────────────────────────────────────

/**
 * Keys of a named top-level object literal, read from source text —
 * `const TOOL_MAP: Record<string, unknown> = { web_search: …, … }` yields
 * ['web_search', …]. Spread entries are skipped: they name no key here.
 * Reading the registry as text keeps a build offline that importing it
 * would not (module side effects, provider clients, credentials).
 */
export function scanObjectKeys(text: string, declName: string): string[] {
  const start = new RegExp(`\\b(?:const|let|var)\\s+${declName}\\b[^=]*=\\s*\\{`).exec(text);
  if (!start) return [];
  let depth = 0;
  let end = -1;
  const open = start.index + start[0].length - 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return [];
  const body = text.slice(open + 1, end);

  const keys = new Set<string>();
  let nesting = 0;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (nesting === 0) {
      const match = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/.exec(trimmed);
      if (match) keys.add(match[1] ?? match[2] ?? match[3]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') nesting++;
      else if (ch === '}' || ch === ']' || ch === ')') nesting--;
    }
    if (nesting < 0) nesting = 0;
  }
  return [...keys].sort();
}

// ── Python ───────────────────────────────────────────────────────────────────

export interface PythonScan {
  /** Repo-relative paths of local modules this file imports. */
  localImports: string[];
  /** Third-party / stdlib top-level package names. */
  packages: string[];
  /** Environment variables the module reads. */
  envVars: string[];
}

const PY_IMPORT_RE = /(?:^|\n)\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)/g;
const PY_FROM_RE = /(?:^|\n)\s*from\s+(\.*[A-Za-z_][\w.]*|\.+)\s+import\s+/g;
const PY_ENV_RE =
  /os\.environ(?:\.get)?\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|os\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]|os\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g;

/**
 * Resolve a Python module path against the files a repo actually has.
 * `services.market_data` → `services/market_data.py`; a leading dot is
 * package-relative to the importing file's directory. Anything that does
 * not land on a known file is treated as a third-party package, which is
 * the conservative reading — a wrong local edge is worse than a missing one.
 */
export function resolvePythonImport(
  fromRelPath: string,
  moduleName: string,
  known: ReadonlySet<string>,
): string | null {
  const dots = /^\.*/.exec(moduleName)?.[0].length ?? 0;
  const bare = moduleName.slice(dots);
  let baseDir = posix.dirname(fromRelPath);
  for (let i = 1; i < dots; i++) baseDir = posix.dirname(baseDir);

  const segments = bare === '' ? [] : bare.split('.');
  const candidates: string[] = [];
  if (dots > 0) {
    const joined = [baseDir, ...segments].filter((p) => p && p !== '.').join('/');
    candidates.push(`${joined}.py`, `${joined}/__init__.py`);
  } else {
    const joined = segments.join('/');
    candidates.push(`${joined}.py`, `${joined}/__init__.py`);
    // A module imported by bare name from the repo root, e.g. `import advisor`.
    if (segments.length === 1) candidates.push(`${segments[0]}.py`);
  }
  return candidates.find((c) => known.has(c)) ?? null;
}

export function scanPython(
  text: string,
  relPath: string,
  knownFiles: ReadonlySet<string>,
): PythonScan {
  const modules = new Set<string>();
  PY_IMPORT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PY_IMPORT_RE.exec(text)) !== null) {
    for (const name of match[1].split(',')) modules.add(name.trim());
  }
  PY_FROM_RE.lastIndex = 0;
  while ((match = PY_FROM_RE.exec(text)) !== null) modules.add(match[1].trim());

  const localImports = new Set<string>();
  const packages = new Set<string>();
  for (const moduleName of modules) {
    const local = resolvePythonImport(relPath, moduleName, knownFiles);
    if (local && local !== relPath) localImports.add(local);
    else if (!moduleName.startsWith('.')) packages.add(moduleName.split('.')[0]);
  }

  const envVars = new Set<string>();
  PY_ENV_RE.lastIndex = 0;
  while ((match = PY_ENV_RE.exec(text)) !== null) {
    envVars.add(match[1] ?? match[2] ?? match[3]);
  }

  return {
    localImports: [...localImports].sort(),
    packages: [...packages].sort(),
    envVars: [...envVars].sort(),
  };
}

// ── Procfile ─────────────────────────────────────────────────────────────────

export interface ProcfileEntry {
  /** Process type — the dyno name. */
  name: string;
  command: string;
  /** The script the process runs, when the command names one. */
  entry: string | null;
}

const PROC_ENTRY_RE = /(?:^|\s)([\w./-]+\.(?:py|ts|js|mjs|sh))(?:\s|$)/;

export function scanProcfile(text: string): ProcfileEntry[] {
  const entries: ProcfileEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const command = trimmed.slice(colon + 1).trim();
    if (name === '' || command === '') continue;
    entries.push({ name, command, entry: PROC_ENTRY_RE.exec(command)?.[1] ?? null });
  }
  return entries;
}
