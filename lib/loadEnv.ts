/**
 * lib/loadEnv.ts — minimal, dependency-free .env loader.
 *
 * WHY this exists:
 *   The project avoids a runtime dependency on `dotenv`, so every entrypoint
 *   loads `.env` through this one helper.
 *
 * Which files, in order (the first value set for a name wins, and anything
 * already in the environment beats every file):
 *   1. `<cwd>/.env` — the consumer's own project. An installed bin
 *      (`npx melchizedek-chat`) lives under node_modules, so reading only the
 *      file next to the script made the bins ignore the user's keys while
 *      `melchizedek-doctor` (which reads cwd) said they were set.
 *   2. `<repo root of the calling script>/.env` — a clone run from another
 *      directory still finds its own file.
 *
 * Values that are still `.env.example` placeholders (`your_..._here`,
 * `<...>`) are skipped: copying the template must not make a placeholder act
 * as a credential. Before this, `cp .env.example .env` crashed the default
 * quickstart (`Invalid supabaseUrl`), made the doctor report every provider
 * funded, and turned the example bearer secret into a live one.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True for template placeholders that must never act as real values. */
export function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  return (
    /^your[_-].*[_-]here$/i.test(v)
    || /^<[^>]*>$/.test(v)
    || /^(changeme|change-me|replace-me|xxx+|todo)$/i.test(v)
  );
}

/** Parse one .env file's text into name → value. Exported for tests. */
export function parseEnvFile(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = trimmed.slice(eq + 1).trim();
    const quote = val[0];
    if ((quote === '"' || quote === "'") && val.lastIndexOf(quote) > 0) {
      val = val.slice(1, val.lastIndexOf(quote));
    } else {
      // An unquoted value ends at an inline comment (" #").
      const hash = val.search(/\s#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    out.set(key, val);
  }
  return out;
}

/**
 * Populate process.env from `.env` files (see the header for the order).
 *
 * @param moduleUrl Pass `import.meta.url` from an entrypoint script so a
 *   clone run from another directory still finds its own `.env`.
 */
export function loadEnv(moduleUrl?: string): void {
  const files = [join(process.cwd(), '.env')];
  if (moduleUrl) {
    const own = join(findRepoRoot(dirname(fileURLToPath(moduleUrl))), '.env');
    if (resolve(own) !== resolve(files[0])) files.push(own);
  }
  for (const file of files) {
    let raw: string;
    try {
      raw = readFileSync(file, 'utf-8');
    } catch {
      continue; // not present — rely on the ambient environment
    }
    for (const [key, val] of parseEnvFile(raw)) {
      if (process.env[key]) continue;
      if (!val || isPlaceholderValue(val)) continue;
      process.env[key] = val;
    }
  }
}

/** Nearest ancestor of `dir` containing package.json; `dir` itself if none. */
function findRepoRoot(dir: string): string {
  let current = dir;
  while (true) {
    if (existsSync(join(current, 'package.json'))) return current;
    const parent = dirname(current);
    if (parent === current) return dir;
    current = parent;
  }
}
