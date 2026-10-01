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
 *   npm run doctor -- --matrix        # the provider × capability matrix
 *   npm run doctor -- --fix-namespaces [file…]   # give long-term syndicates a memory_namespace
 *   MELCHIZEDEK_AGENTS_DIR=/path npm run doctor
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadEnv } from '../lib/loadEnv.ts';
import { renderDoctor, runDoctor } from '../lib/doctor.ts';
import { renderCapabilityMatrix } from '../lib/models/capabilities.ts';
import { assignMemoryNamespace, LEGACY_MEMORY_APP_NAME } from '../lib/memory/namespace.ts';

loadEnv();

const args = process.argv.slice(2);
const json = args.includes('--json');
const check = args.includes('--check');
const matrix = args.includes('--matrix');
const fixAt = args.indexOf('--fix-namespaces');
const noColor = args.includes('--no-color') || !!process.env.NO_COLOR || !process.stdout.isTTY;

function packageScripts(): Record<string, string> | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'));
    return pkg.scripts ?? undefined;
  } catch {
    return undefined;
  }
}

if (fixAt !== -1) {
  // ADR 0020: give each named long-term syndicate its own memory namespace.
  // Only the files named are touched; with none named, list the candidates.
  const agentsDir = path.resolve(process.env.MELCHIZEDEK_AGENTS_DIR ?? path.join(process.cwd(), 'config', 'agents'));
  const files = args.slice(fixAt + 1).filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    const pending = runDoctor({ agentsDir }).syndicates.filter((s) => s.memory && !s.memory.declared && !s.file.includes('/'));
    console.log(
      pending.length
        ? `Long-term syndicates without a memory_namespace:\n${pending.map((s) => `  ${s.file}`).join('\n')}\n\nName the files to assign one: npm run doctor -- --fix-namespaces ${pending[0].file}`
        : 'Every long-term syndicate declares a memory_namespace.',
    );
    process.exit(0);
  }
  for (const f of files) {
    const filePath = path.isAbsolute(f) ? f : path.join(agentsDir, f);
    const r = assignMemoryNamespace(filePath);
    console.log(
      r.status === 'assigned'
        ? `${f}: memory_namespace "${r.namespace}". Facts already stored under "${LEGACY_MEMORY_APP_NAME}" stay there until re-keyed; do not deploy this file to a server with live memory before deciding that.`
        : `${f}: already declares "${r.namespace}" (unchanged).`,
    );
  }
  process.exit(0);
}

if (matrix) {
  // What each path can do, independent of any YAML or key (ADR 0019).
  console.log(renderCapabilityMatrix());
  process.exit(0);
}

const result = runDoctor({ scripts: packageScripts() });

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(renderDoctor(result, { color: !noColor }));
}

if (check && result.counts.blocked > 0) process.exit(1);
