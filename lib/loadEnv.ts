/**
 * lib/loadEnv.ts — minimal, dependency-free .env loader.
 *
 * WHY this exists:
 *   The project runs via `node --experimental-strip-types` and intentionally
 *   avoids a runtime dependency on `dotenv`. Several scripts previously did
 *   `import 'dotenv/config'`, which throws because `dotenv` is not installed.
 *   This shared helper replicates the same parse used inline by a2a_server.ts
 *   and syndicate_chat.ts, so every entrypoint loads `.env` the same way.
 *
 * Existing process.env values always win — the file only fills in what's unset.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Populate process.env from the repo-root `.env` file.
 *
 * @param moduleUrl Pass `import.meta.url` from a script in `scripts/` so the
 *   `.env` is resolved relative to the repo root regardless of cwd. When
 *   omitted, `process.cwd()` is used.
 */
export function loadEnv(moduleUrl?: string): void {
  try {
    const root = moduleUrl
      ? join(fileURLToPath(moduleUrl), '..', '..')
      : process.cwd();
    const raw = readFileSync(join(root, '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // .env not present — rely on the ambient environment.
  }
}
