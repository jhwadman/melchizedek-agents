#!/usr/bin/env node
/**
 * scripts/doctor.ts — which keys do I need, and what does each unlock?
 *
 * Reads every syndicate YAML the loader can see (config/agents root and
 * examples/), resolves each agent's model to its provider under the current
 * .env, and prints: the provider, whether that path is funded (direct key,
 * gateway stand-in, or local), which declared server-side tools it keeps or
 * drops, and one verdict per syndicate. Closes with the env vars that would
 * unlock the most, where to get each, and the first command to try.
 *
 * Read-only: never edits .env, never sends a request, never prints a key
 * value. The live counterpart is `npm run demo:models`.
 *
 * Usage:
 *   npm run doctor
 *   npm run doctor -- --json          # machine-readable
 *   npm run doctor -- --check         # exit 1 when any syndicate is blocked
 *   MELCHIZEDEK_AGENTS_DIR=/path npm run doctor
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from '../lib/loadEnv.ts';
import { renderDoctor, runDoctor } from '../lib/doctor.ts';

loadEnv();

const args = process.argv.slice(2);
const json = args.includes('--json');
const check = args.includes('--check');
const noColor = args.includes('--no-color') || !!process.env.NO_COLOR || !process.stdout.isTTY;

function packageScripts(): Record<string, string> | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.scripts ?? undefined;
  } catch {
    return undefined;
  }
}

const result = runDoctor({ scripts: packageScripts() });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderDoctor(result, { color: !noColor }));
}

if (check && result.counts.blocked > 0) process.exit(1);
