#!/usr/bin/env node
/**
 * scripts/gen_syndicate_schema.ts — write config/agents/syndicate.schema.json.
 *
 * The JSON Schema is DERIVED from the zod contract in lib/syndicateSchema.ts
 * (the one the loader enforces), never edited by hand. Editors read it
 * through a `# yaml-language-server: $schema=` modeline;
 * tests/syndicateSchema.test.ts fails when the committed file and this
 * output disagree, so a schema change without a regenerate cannot land.
 *
 * Usage:
 *   npm run schema:gen
 *   npm run schema:gen -- --check   # exit 1 if the committed file is stale
 */

import fs from 'node:fs';
import path from 'node:path';

import { syndicateJsonSchema } from '../lib/syndicateSchema.ts';

const target = path.join(process.cwd(), 'config', 'agents', 'syndicate.schema.json');
const next = JSON.stringify(syndicateJsonSchema(), null, 2) + '\n';

if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
  if (current !== next) {
    console.error(`${path.relative(process.cwd(), target)} is stale — run npm run schema:gen`);
    process.exit(1);
  }
  console.log(`${path.relative(process.cwd(), target)} is current`);
} else {
  fs.writeFileSync(target, next);
  console.log(`wrote ${path.relative(process.cwd(), target)}`);
}
