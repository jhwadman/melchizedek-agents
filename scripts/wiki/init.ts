/**
 * scripts/wiki/init.ts — scaffold a fresh OKF knowledge bundle.
 *
 * WHY this file exists:
 *   The wiki tooling (lib/wiki, lib/tools/wikiTools.ts, the MCP server) is
 *   bundle-agnostic; this script plants a minimal, conformant bundle to
 *   point it at: a root index.md declaring okf_version, a log.md with its
 *   founding entry, and a meta document that teaches the format profile to
 *   whoever (human or agent) gardens next. Idempotent by refusal: an
 *   existing root index means a bundle is already here.
 *
 * RUN:  npm run wiki:init            (creates <repo>/wiki, or $WIKI_ROOT)
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadEnv } from '../../lib/loadEnv.ts';
import { appendLog, indexSpec, renderDoc, upsertDoc } from '../../lib/wiki/builder.ts';
import { BUILD_ACTOR, CONCEPT_TYPES, OKF_VERSION } from '../../lib/wiki/format.ts';
import { writeDocFile, resolveWikiRoot } from '../../lib/wiki/vault.ts';

loadEnv(import.meta.url);

const root = resolveWikiRoot();
const today = new Date().toISOString().slice(0, 10);
const ctx = { actor: BUILD_ACTOR, date: today };

if (existsSync(join(root, 'index.md'))) {
  console.error(`A bundle already exists at ${root} — nothing to do.`);
  process.exit(1);
}
mkdirSync(root, { recursive: true });

// The meta document: the profile, stated inside the bundle it governs.
const metaDoc = renderDoc(
  {
    bundlePath: '/meta/wiki-system.md',
    fm: {
      type: 'meta',
      title: 'How this knowledge bundle works',
      description:
        'The format profile: OKF frontmatter, link rules, reserved files, and the tools that navigate and garden this bundle.',
      tags: ['meta', 'okf'],
    },
    body: [
      {
        kind: 'prose',
        markdown: `# How this knowledge bundle works

This directory is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog) v${OKF_VERSION} bundle: markdown concept documents with YAML frontmatter, linked with normal markdown links. The links ARE the knowledge graph.

## The profile

- Frontmatter requires one key: \`type\`. Vocabulary: ${CONCEPT_TYPES.join(', ')}.
- Useful optional keys: \`title\`, \`description\`, \`tags\`, \`status\` (draft|stable|deprecated), \`stale_after\` (YYYY-MM-DD), \`generated {by, at}\`, \`verified [{by, at}]\`, \`sources [{resource, title}]\`.
- Actors: \`human:<id>\`, \`process:<id>\`, or \`<producer>/<model>\`. Only a \`human:\` entry in \`verified\` makes a document human-reviewed.
- Links are bundle-absolute: \`[Title](/dir/doc.md)\`. No wikilink syntax.
- \`index.md\` (per directory) and \`log.md\` (bundle root) are reserved and machine-maintained.
- Knowledge that must not leave this repo lives under \`/private/\`; nothing outside that subtree may link into it.

## Working the bundle

Navigate with the wiki tools (over MCP or as agent tools): \`wiki_map\`, \`wiki_search\`, \`wiki_read\`, \`wiki_links\`, \`wiki_dive\`. Write through \`wiki_save\` — lint gates every write — or delegate to \`wiki_garden\`. Health-check with \`wiki:check\`; regenerate structural sections with \`wiki:build\`.`,
      },
    ],
  },
  ctx,
);
writeDocFile(root, '/meta/wiki-system.md', metaDoc);

upsertDoc(
  root,
  indexSpec('/meta/', 'Meta', [
    {
      bundlePath: '/meta/wiki-system.md',
      title: 'How this knowledge bundle works',
      description: 'format profile, tools, gardening rules',
    },
  ]),
  ctx,
);

upsertDoc(
  root,
  indexSpec(
    '/',
    'Knowledge bundle',
    [],
    [{ bundlePath: '/meta/', title: 'Meta', description: 'how this bundle itself works' }],
    {
      okf_version: OKF_VERSION,
      title: 'Knowledge bundle',
      description: 'An OKF bundle. Start at /meta/wiki-system.md.',
    },
  ),
  ctx,
);

appendLog(root, today, 'init', 'bundle scaffolded', `by ${BUILD_ACTOR}`);

console.log(`Bundle scaffolded at ${root}`);
console.log('Next: garden concept documents in, or point wiki:build sources at it.');
