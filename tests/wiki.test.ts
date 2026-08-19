/**
 * tests/wiki.test.ts — offline tests for the knowledge-bundle layer.
 *
 * Everything here runs with NO network and NO API keys, against throwaway
 * bundles in a temp directory:
 *   - the OKF profile (frontmatter schemas, trust tiers, actors, staleness)
 *   - the structural markdown engine (parse, sections, surgical edits)
 *   - vault loading, link resolution, and the write jail
 *   - graph derivation (edges, orphans, neighborhoods)
 *   - lint rules (conformance, closure, coverage, forbidden terms)
 *   - search scoring and repo-dive planning
 *   - the builder's refresh contract (regenerate structure, preserve prose)
 *   - the wiki_save gate end to end (reject → accept → index + log effects)
 *   - the source scanners behind the entity layer (imports, env, DDL, scripts)
 *   - the entity graph: dedupe, typed walks, paths, lint, the two stores
 *   - the wiki_relate gate (derived relations refused, closure, private log)
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLogLevel, LogLevel } from '@google/adk';

import {
  actorSchema,
  conceptFrontmatterSchema,
  isStale,
  trustTier,
  verifiedEntries,
} from '../lib/wiki/format.ts';
import {
  emitDoc,
  insertLogEntry,
  parseDoc,
  sectionSlice,
  setGeneratedContent,
  setSlotContent,
  slotIsUnfilled,
  table,
} from '../lib/wiki/markdown.ts';
import {
  jailedAbsPath,
  loadVault,
  makeWikiDoc,
  resolveLinkTarget,
} from '../lib/wiki/vault.ts';
import { buildGraph, neighborhood, orphanConcepts } from '../lib/wiki/graph.ts';
import { lintVault } from '../lib/wiki/lint.ts';
import { repoDive, scoreDocs } from '../lib/wiki/dive.ts';
import { refreshDoc, renderDoc, type DocSpec } from '../lib/wiki/builder.ts';
import {
  buildEntityGraph,
  entityStats,
  findNodes,
  lintEntityGraph,
  loadEntityGraph,
  neighbors,
  nodesOfKind,
  saveRelations,
  shortestPath,
  snapshotDrift,
  writeSnapshot,
} from '../lib/wiki/entities.ts';
import {
  resolveLocalImport,
  scanModule,
  scanNpmScripts,
  scanObjectKeys,
  scanSql,
  tableMentions,
} from '../lib/wiki/extract.ts';
import { executeContract } from '../lib/tools/toolContract.ts';
import {
  wikiGraphContract,
  wikiRelateContract,
  wikiSaveContract,
  wikiSearchContract,
} from '../lib/tools/wikiTools.ts';

setLogLevel(LogLevel.WARN);

const CTX = { actor: 'process:wiki-build', date: '2026-07-26' };

/** Write a throwaway bundle and return its root. */
function makeBundle(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wiki-test-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const FM = (extra = ''): string =>
  `---\ntype: guide\ntitle: Doc\n${extra}---\n\n`;

// ── Format profile ───────────────────────────────────────────────────────────

test('frontmatter requires only a non-empty type; unknown keys pass through', () => {
  assert.ok(conceptFrontmatterSchema.safeParse({ type: 'guide' }).success);
  assert.ok(!conceptFrontmatterSchema.safeParse({}).success);
  assert.ok(!conceptFrontmatterSchema.safeParse({ type: '' }).success);
  const parsed = conceptFrontmatterSchema.parse({ type: 'guide', custom_key: 42 });
  assert.equal((parsed as Record<string, unknown>).custom_key, 42);
});

test('verified: bare mapping is a one-element list; trust tiers derive from actors', () => {
  const machine = conceptFrontmatterSchema.parse({
    type: 'guide',
    verified: { by: 'reference_agent/gemini-3.7-flash' },
  });
  assert.equal(verifiedEntries(machine).length, 1);
  assert.equal(trustTier(machine), 'machine-confirmed');

  const human = conceptFrontmatterSchema.parse({
    type: 'guide',
    verified: [{ by: 'melchizedek/gemini' }, { by: 'human:jimmy' }],
  });
  assert.equal(trustTier(human), 'human-reviewed');
  assert.equal(trustTier(conceptFrontmatterSchema.parse({ type: 'guide' })), 'unverified');
});

test('actor convention accepts the three forms and rejects bare names', () => {
  for (const ok of ['human:jimmy', 'process:wiki-build', 'melchizedek/gemini-3.7-flash']) {
    assert.ok(actorSchema.safeParse(ok).success, ok);
  }
  for (const bad of ['jimmy', 'human:', 'process:']) {
    assert.ok(!actorSchema.safeParse(bad).success, bad);
  }
});

test('staleness is a plain date comparison', () => {
  const fm = conceptFrontmatterSchema.parse({ type: 'guide', stale_after: '2026-07-01' });
  assert.ok(isStale(fm, '2026-07-26'));
  assert.ok(!isStale(fm, '2026-06-30'));
});

// ── Structural markdown engine ───────────────────────────────────────────────

test('parseDoc extracts frontmatter, headings, links; fences and inline code mask', () => {
  const raw = emitDoc(
    { type: 'guide', title: 'T' },
    [
      '# Title',
      'See [Other](/dir/other.md) and [ext](https://example.com).',
      'Syntax example: `[not-a-link](/nope.md)`',
      '```md',
      '[fenced](/also-not-counted.md)',
      '## not a heading',
      '```',
      '## Second section',
      'Body [[wikilink]] here.',
    ].join('\n'),
  );
  const doc = parseDoc(raw);
  assert.equal(doc.frontmatter?.type, 'guide');
  assert.deepEqual(doc.headings.map((h) => h.text), ['Title', 'Second section']);
  assert.deepEqual(doc.links.map((l) => l.target), ['/dir/other.md', 'https://example.com']);
  assert.equal(doc.wikilinks.length, 1);
  assert.equal(doc.fences.length, 1);

  const slice = sectionSlice(doc, 'second-section');
  assert.ok(slice && slice.text.includes('wikilink'));
});

test('surgical edits splice slots and generated blocks without touching prose', () => {
  const raw = [
    'intact prose above',
    '<!-- wiki:fill slot="a" -->',
    '_TODO(fill): hint_',
    '<!-- /wiki:fill -->',
    '<!-- wiki:generated section="g" source="x" -->',
    'old generated',
    '<!-- /wiki:generated -->',
    'intact prose below',
  ].join('\n');

  const filled = setSlotContent(raw, 'a', 'real prose.');
  assert.ok(filled?.includes('real prose.'));
  assert.ok(!filled?.includes('TODO'));
  const regen = setGeneratedContent(filled!, 'g', 'new generated');
  assert.ok(regen?.includes('new generated'));
  assert.ok(!regen?.includes('old generated'));
  assert.ok(regen?.startsWith('intact prose above'));
  assert.ok(regen?.trimEnd().endsWith('intact prose below'));
  assert.equal(setSlotContent(raw, 'missing', 'x'), null);

  const slot = parseDoc(raw).slots[0];
  assert.ok(slotIsUnfilled(slot));
});

test('log entries insert newest-first after the preamble', () => {
  const log = '# Log\n\npreamble.\n\n## [2026-07-01] init | first\n';
  const next = insertLogEntry(log, '## [2026-07-26] garden | second');
  const first = next.indexOf('2026-07-26');
  const second = next.indexOf('2026-07-01');
  assert.ok(first !== -1 && second !== -1 && first < second);
});

test('table escapes pipes and newlines in cells', () => {
  const t = table(['A'], [['x|y\nz']]);
  assert.ok(t.includes('x\\|y z'));
});

// ── Vault: link resolution and the write jail ────────────────────────────────

test('resolveLinkTarget normalizes forms and flags escapes', () => {
  assert.deepEqual(resolveLinkTarget('/a/b.md', '/c/d.md'), {
    kind: 'internal',
    bundlePath: '/c/d.md',
  });
  assert.deepEqual(resolveLinkTarget('/a/b.md', 'sibling.md'), {
    kind: 'internal',
    bundlePath: '/a/sibling.md',
  });
  assert.deepEqual(resolveLinkTarget('/a/b.md', '/dir/'), {
    kind: 'internal',
    bundlePath: '/dir/index.md',
  });
  assert.equal(resolveLinkTarget('/a/b.md', 'https://x.y/z').kind, 'external');
  assert.equal(resolveLinkTarget('/a/b.md', '#anchor').kind, 'anchor');
  // Traversal clamps at the bundle root (absolute normalization): the
  // "escape" resolves to a bundle path — jailed, and simply nonexistent.
  assert.deepEqual(resolveLinkTarget('/a.md', '../../etc/passwd'), {
    kind: 'internal',
    bundlePath: '/etc/passwd',
  });
});

test('jailedAbsPath keeps every path inside the bundle', () => {
  const root = makeBundle({});
  // Absolute normalization clamps traversal at the bundle root…
  const clamped = jailedAbsPath(root, '/../../outside.md');
  assert.ok(clamped.startsWith(root), clamped);
  assert.ok(jailedAbsPath(root, '/a/../../b/../deep/ok.md').startsWith(root));
  // …and nothing resolvable lands outside it.
  assert.ok(jailedAbsPath(root, '/deep/ok.md').startsWith(root));
  rmSync(root, { recursive: true, force: true });
});

// ── Graph ────────────────────────────────────────────────────────────────────

test('graph derives edges, flags broken links and orphans, walks neighborhoods', () => {
  const root = makeBundle({
    'index.md': '# Root\n\n- [A](/a.md) — a\n',
    'a.md': `${FM()}# A\n\nSee [B](/b.md) and [missing](/nope.md).\n`,
    'b.md': `${FM()}# B\n\nback to [A](/a.md)\n`,
    'orphan.md': `${FM()}# Orphan\n\nno inbound.\n`,
  });
  const vault = loadVault(root);
  const graph = buildGraph(vault);

  const broken = graph.edges.filter((e) => !e.resolved);
  assert.equal(broken.length, 1);
  assert.equal(broken[0].target, '/nope.md');

  const orphans = orphanConcepts(graph).map((n) => n.path);
  assert.deepEqual(orphans, ['/orphan.md']);

  const hood = neighborhood(graph, '/a.md', 2, 'both');
  assert.ok(hood.some((n) => n.node.path === '/b.md' && n.distance === 1));
  rmSync(root, { recursive: true, force: true });
});

// ── Lint ─────────────────────────────────────────────────────────────────────

test('lint: conformance errors, closure violations, forbidden terms, coverage', () => {
  const root = makeBundle({
    'index.md': '# Root\n\n- [Good](/good.md) — g\n- [Bad](/bad.md) — b\n- [Leak](/leak.md) — l\n',
    'good.md': `${FM()}# Good\n\n[[wikilinks are banned]]\n`,
    'bad.md': '# Bad\n\nno frontmatter at all.\n',
    'leak.md': `${FM()}# Leak\n\nlinks [private](/private/secret.md) and mentions SecretSystem.\n`,
    'private/index.md': '# Private\n\n- [Secret](/private/secret.md) — s\n',
    'private/secret.md': `${FM()}# Secret\n\nfine here: SecretSystem. Links [Good](/good.md).\n`,
    'unlisted.md': `${FM()}# Unlisted\n\n[Good](/good.md)\n`,
  });
  const report = lintVault(loadVault(root), {
    forbiddenPatterns: [/SecretSystem/],
  });
  const rules = (rule: string) => report.findings.filter((f) => f.rule === rule);

  assert.equal(rules('wikilink-syntax').length, 1);
  assert.ok(rules('frontmatter').some((f) => f.docPath === '/bad.md'));
  assert.equal(rules('private-closure').length, 1);
  const forbidden = rules('forbidden-term');
  assert.equal(forbidden.length, 1, 'private docs are exempt from the term scan');
  assert.equal(forbidden[0].docPath, '/leak.md');
  assert.ok(rules('index-coverage').some((f) => f.message.includes('/unlisted.md')));
  assert.ok(!report.ok);
  rmSync(root, { recursive: true, force: true });
});

// ── Search and dive ──────────────────────────────────────────────────────────

test('search ranks title/tag hits above body hits; dive orients then cores', () => {
  const root = makeBundle({
    'index.md': '# Root\n\n- [Routing](/models/routing.md) — r\n- [Other](/other.md) — o\n',
    'models/index.md': '# Models\n\n- [Routing](/models/routing.md) — r\n',
    'models/routing.md': `---\ntype: subsystem\ntitle: Provider routing\ntags:\n  - routing\n---\n\n# Provider routing\n\nadapters and prefixes. See [Other](/other.md).\n`,
    'other.md': `${FM()}# Other\n\nadapters live here, linked from the seed.\n`,
  });
  const vault = loadVault(root);
  const results = scoreDocs(vault, 'provider routing');
  assert.equal(results[0].doc.bundlePath, '/models/routing.md');
  assert.ok(results[0].score > (results[1]?.score ?? 0));

  const plan = repoDive(vault, 'change provider routing', 5000);
  assert.equal(plan.stops[0].path, '/index.md');
  assert.equal(plan.stops[0].role, 'orient');
  assert.ok(plan.stops.some((s) => s.path === '/models/routing.md' && s.role === 'core'));
  assert.ok(plan.stops.some((s) => s.path === '/other.md' && s.role === 'context'));
  rmSync(root, { recursive: true, force: true });
});

// ── Builder refresh contract ─────────────────────────────────────────────────

test('refresh regenerates machine sections, preserves prose and filled slots, bumps only on change', () => {
  const spec: DocSpec = {
    bundlePath: '/x.md',
    fm: { type: 'syndicate', title: 'X' },
    body: [
      { kind: 'prose', markdown: '# X' },
      { kind: 'fill', id: 'charter', hint: 'why' },
      { kind: 'generated', id: 'comp', source: 's', markdown: 'v1 table' },
    ],
  };
  const v1 = renderDoc(spec, CTX);
  assert.ok(v1.includes('v1 table') && v1.includes('_TODO(fill): why_'));

  // A human/LLM fills the slot and adds trailing prose.
  const filled = `${setSlotContent(v1, 'charter', 'hand-written charter.')!}\nTrailing hand prose.\n`;

  // Repo truth changes → regenerate.
  const spec2: DocSpec = {
    ...spec,
    body: spec.body.map((p) =>
      p.kind === 'generated' ? { ...p, markdown: 'v2 table' } : p,
    ),
  };
  const { raw: v2, changed } = refreshDoc(filled, spec2, { ...CTX, date: '2026-07-27' });
  assert.ok(changed);
  assert.ok(v2.includes('v2 table') && !v2.includes('v1 table'));
  assert.ok(v2.includes('hand-written charter.'), 'filled slot survives');
  assert.ok(v2.includes('Trailing hand prose.'), 'prose outside markers survives');
  assert.ok(v2.includes('at: 2026-07-27'), 'generated.at bumped on change');

  const again = refreshDoc(v2, spec2, { ...CTX, date: '2026-07-28' });
  assert.ok(!again.changed, 'idempotent when nothing changed');
  assert.ok(!again.raw.includes('2026-07-28'));
});

// ── wiki_save gate end to end ────────────────────────────────────────────────

test('wiki_save rejects nonconformant drafts and lands conformant ones with index + log', async () => {
  const root = makeBundle({
    'index.md': '# Root\n\n- [Guides](/guides/) — g\n',
    'log.md': '# Log\n\n## [2026-07-01] init | scaffolded\n',
    'guides/index.md': '# Guides\n\n- [Old](/guides/old.md) — o\n',
    'guides/old.md': `${FM()}# Old\n\nlinks [root](/index.md)\n`,
  });
  process.env.WIKI_ROOT = root;
  try {
    const reject = await executeContract(wikiSaveContract, {
      path: '/guides/new.md',
      content: '# No frontmatter\n\n[[banned]] too\n',
      actor: 'human:jimmy',
      summary: 'should not land',
    });
    assert.ok(reject.startsWith('REJECTED'));
    assert.ok(reject.includes('frontmatter') && reject.includes('wikilink'));

    const reserved = await executeContract(wikiSaveContract, {
      path: '/guides/index.md',
      content: `${FM()}# X\n`,
      actor: 'human:jimmy',
      summary: 'reserved write',
    });
    assert.ok(reserved.startsWith('Error:') && reserved.includes('reserved'));

    const accept = await executeContract(wikiSaveContract, {
      path: '/guides/new.md',
      content: `---\ntype: guide\ntitle: New guide\ndescription: fresh\n---\n\n# New guide\n\nSee [Old](/guides/old.md).\n`,
      actor: 'human:jimmy',
      summary: 'plant new guide',
    });
    assert.ok(accept.startsWith('CREATED /guides/new.md'), accept);

    const index = readFileSync(join(root, 'guides/index.md'), 'utf-8');
    assert.ok(index.includes('/guides/new.md'), 'directory index refreshed');
    const log = readFileSync(join(root, 'log.md'), 'utf-8');
    assert.ok(log.includes('plant new guide') && log.includes('human:jimmy'));

    const search = await executeContract(wikiSearchContract, { query: 'new guide', limit: 5 });
    assert.ok(search.includes('/guides/new.md'));
  } finally {
    delete process.env.WIKI_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Source scanners (the extracted tier's eyes) ──────────────────────────────

test('scanners read imports, env, DDL and scripts literally — and only literally', () => {
  const source = [
    "import { a } from './alpha.ts';",
    'import {',
    '  b,',
    "} from '../beta/gamma.ts';",
    "export { c } from './delta.ts';",
    "import 'node:fs';",
    "const late = await import('./late.ts');",
    'const key = process.env.MY_KEY;',
    "const other = process.env['OTHER_KEY'];",
    "// mentions adk_sessions in prose only",
    "await db.from('adk_memory_facts').select();",
  ].join('\n');
  const scan = scanModule(source, 'lib/wiki/thing.ts');
  assert.deepEqual(scan.localImports, [
    'lib/beta/gamma.ts',
    'lib/wiki/alpha.ts',
    'lib/wiki/delta.ts',
    'lib/wiki/late.ts',
  ]);
  assert.deepEqual(scan.packages, ['node:fs']);
  assert.deepEqual(scan.envVars, ['MY_KEY', 'OTHER_KEY']);
  assert.equal(resolveLocalImport('lib/a/b.ts', '../../escape.ts'), 'escape.ts');
  assert.equal(resolveLocalImport('lib/a/b.ts', 'yaml'), null);

  // Quoted only: the comment mentioning adk_sessions must not count.
  assert.deepEqual(
    tableMentions(source, ['adk_memory_facts', 'adk_sessions']),
    ['adk_memory_facts'],
  );

  const sql = scanSql(`
    CREATE TABLE IF NOT EXISTS public.adk_telemetry (id uuid);
    ALTER TABLE adk_memory_facts ENABLE ROW LEVEL SECURITY;
  `);
  assert.deepEqual(sql.defined, ['adk_telemetry']);
  assert.deepEqual(sql.referenced, ['adk_memory_facts']);

  const scripts = scanNpmScripts({
    'syndicate:critic': 'node scripts/syndicate_chat.ts --syndicate critic',
    build: 'tsc -p .',
  });
  const critic = scripts.find((s) => s.name === 'syndicate:critic')!;
  assert.equal(critic.entry, 'scripts/syndicate_chat.ts');
  assert.equal(critic.flags.syndicate, 'critic');
  assert.equal(scripts.find((s) => s.name === 'build')!.entry, null);

  assert.deepEqual(
    scanObjectKeys(
      "const TOOL_MAP: Record<string, unknown> = {\n  ...SPREAD,\n  web_search: WEB,\n  'x_search': X,\n  nested: { inner: 1 },\n};\n",
      'TOOL_MAP',
    ),
    ['nested', 'web_search', 'x_search'],
  );
});

// ── Entity graph ─────────────────────────────────────────────────────────────

const NODES = [
  { id: '/decisions/0003.md', kind: 'doc', label: 'ADR 0003' },
  { id: '/private/secret.md', kind: 'doc', label: 'Secret', private: true },
  { id: 'module:lib/wiki/lint.ts', kind: 'module', label: 'lint.ts' },
  { id: 'tool:wiki_save', kind: 'tool', label: 'wiki_save' },
  { id: 'agent:scriptorium/Illuminator', kind: 'agent', label: 'Illuminator' },
  { id: 'syndicate:scriptorium', kind: 'syndicate', label: 'The Scriptorium' },
];
const EDGES = [
  { from: 'syndicate:scriptorium', to: 'agent:scriptorium/Illuminator', rel: 'contains', tier: 'extracted' as const },
  { from: 'agent:scriptorium/Illuminator', to: 'tool:wiki_save', rel: 'uses_tool', tier: 'extracted' as const },
  { from: 'tool:wiki_save', to: 'module:lib/wiki/lint.ts', rel: 'defined_in', tier: 'extracted' as const },
];

test('entity graph dedupes, keeps private sticky, and walks typed relations', () => {
  const graph = buildEntityGraph(
    [...NODES, { id: 'tool:wiki_save', kind: 'tool', label: 'wiki_save', attrs: { extra: 1 } }],
    [...EDGES, { ...EDGES[0] }],
  );
  assert.equal(graph.nodes.size, NODES.length, 'node ids are unique');
  assert.equal(graph.edges.length, EDGES.length, 'identical edges collapse');
  assert.equal(graph.nodes.get('tool:wiki_save')!.attrs!.extra, 1, 'attrs merge');

  const out = neighbors(graph, 'syndicate:scriptorium', { depth: 3, direction: 'out' });
  assert.deepEqual(
    out.map((n) => n.node.id),
    ['agent:scriptorium/Illuminator', 'tool:wiki_save', 'module:lib/wiki/lint.ts'],
  );
  const filtered = neighbors(graph, 'syndicate:scriptorium', { depth: 3, relations: ['contains'] });
  assert.equal(filtered.length, 1, 'relation filter stops the walk');

  // Two relations between the same pair must BOTH surface.
  const twice = buildEntityGraph(NODES, [
    ...EDGES,
    { from: 'tool:wiki_save', to: 'module:lib/wiki/lint.ts', rel: 'depends_on', tier: 'inferred' as const, by: 'human:jimmy', evidence: 'the gate calls lint' },
  ]);
  const both = neighbors(twice, 'tool:wiki_save', { direction: 'out' });
  assert.deepEqual(both.map((n) => n.rel).sort(), ['defined_in', 'depends_on']);

  const path = shortestPath(graph, 'module:lib/wiki/lint.ts', 'syndicate:scriptorium');
  assert.equal(path!.length, 4, 'walks edges against their direction too');
  assert.equal(path!.at(-1)!.node.id, 'syndicate:scriptorium');
  assert.equal(shortestPath(graph, 'tool:wiki_save', '/decisions/0003.md'), null);

  assert.equal(findNodes(graph, 'wiki_save')[0].node.id, 'tool:wiki_save');
  assert.deepEqual(nodesOfKind(graph, 'doc').map((n) => n.id), [
    '/decisions/0003.md',
    '/private/secret.md',
  ]);
  const stats = entityStats(graph);
  assert.equal(stats.byKind.doc, 2);
  assert.equal(stats.byRelation.contains, 1);
  assert.equal(stats.isolated, 2, 'both docs are unconnected here');
});

test('graph lint: dangling endpoints, tiers, kinds, closure — closure only for documents', () => {
  const findings = lintEntityGraph(
    buildEntityGraph(NODES, [
      { from: '/decisions/0003.md', to: 'module:nope.ts', rel: 'constrains', tier: 'inferred', by: 'human:jimmy', evidence: 'x' },
      { from: '/decisions/0003.md', to: '/private/secret.md', rel: 'explains', tier: 'inferred', by: 'human:jimmy' },
      { from: 'module:lib/wiki/lint.ts', to: '/private/secret.md', rel: 'depends_on', tier: 'inferred', by: 'human:jimmy' },
      { from: 'module:lib/wiki/lint.ts', to: '/decisions/0003.md', rel: 'links_to', tier: 'extracted' },
      { from: '/decisions/0003.md', to: 'tool:wiki_save', rel: 'constrains', tier: 'extracted' },
      { from: '/decisions/0003.md', to: 'module:lib/wiki/lint.ts', rel: 'depends_on', tier: 'inferred' },
    ]),
  );
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes('dangling-endpoint'));
  assert.equal(
    findings.filter((f) => f.rule === 'private-closure').length,
    1,
    'the public DOCUMENT is caught; a module pointing at private code is not',
  );
  // Kind constraints are declared per relation; this one asserts the rule
  // fires, using a relation that still carries a `from` list.
  assert.ok(rules.includes('kind-constraint'), 'links_to may only start at a document');
  assert.ok(rules.includes('tier-mismatch'), 'an inferred relation tagged extracted is flagged');
  assert.ok(rules.includes('unattributed-assertion'));
  assert.ok(findings.some((f) => f.rule === 'private-closure' && f.severity === 'error'));
});

test('the two stores round-trip: derived snapshot rewritten, assertions preserved', () => {
  const root = makeBundle({ 'index.md': '# Root\n' });
  try {
    const graph = buildEntityGraph(NODES, EDGES);
    writeSnapshot(root, graph, { by: 'process:wiki-build', at: '2026-08-19' });
    saveRelations(root, [
      {
        from: '/decisions/0003.md',
        to: 'module:lib/wiki/lint.ts',
        rel: 'constrains',
        evidence: 'ADR 0003: "no document outside /private/ may link into it"',
        by: 'human:jimmy',
        at: '2026-08-19',
      },
    ]);

    const loaded = loadEntityGraph(root);
    assert.equal(loaded.snapshot!.generated.at, '2026-08-19');
    assert.equal(loaded.inferredCount, 1);
    assert.equal(loaded.graph.edges.length, EDGES.length + 1);
    const asserted = loaded.graph.edges.find((e) => e.tier === 'inferred')!;
    assert.equal(asserted.by, 'human:jimmy');
    assert.ok(asserted.evidence!.includes('link into it'));

    // A rebuild replaces the snapshot and must not touch the assertions.
    writeSnapshot(root, buildEntityGraph(NODES, []), { by: 'process:wiki-build', at: '2026-08-20' });
    const after = loadEntityGraph(root);
    assert.equal(after.graph.edges.length, 1, 'only the assertion survives');
    assert.equal(after.inferredCount, 1);

    writeFileSync(join(root, '.graph/relations.json'), '{ not json');
    assert.equal(loadEntityGraph(root).issues.length, 1, 'a broken store reports, never throws');

    const drift = snapshotDrift(after.snapshot, ['/decisions/0003.md', '/brand-new.md']);
    assert.deepEqual(drift.missing, ['/brand-new.md']);
    assert.deepEqual(drift.removed, ['/private/secret.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── wiki_relate gate end to end ──────────────────────────────────────────────

test('wiki_relate refuses derived relations, dangling ends and closure breaks; logs privately', async () => {
  const root = makeBundle({
    'index.md': '# Root\n',
    'log.md': '# Log\n\n## [2026-07-01] init | scaffolded\n',
  });
  writeSnapshot(root, buildEntityGraph(NODES, EDGES), {
    by: 'process:wiki-build',
    at: '2026-08-19',
  });
  process.env.WIKI_ROOT = root;
  try {
    const derived = await executeContract(wikiRelateContract, {
      from: 'agent:scriptorium/Illuminator',
      to: 'tool:wiki_save',
      relation: 'uses_tool',
      evidence: 'the YAML declares it',
      actor: 'human:jimmy',
    });
    assert.ok(derived.startsWith('REJECTED') && derived.includes('EXTRACTED'), derived);

    const dangling = await executeContract(wikiRelateContract, {
      from: '/decisions/0003.md',
      to: 'module:does/not/exist.ts',
      relation: 'constrains',
      evidence: 'ADR 0003 says so somewhere',
      actor: 'human:jimmy',
    });
    assert.ok(dangling.startsWith('REJECTED') && dangling.includes('no node'), dangling);

    const leak = await executeContract(wikiRelateContract, {
      from: '/decisions/0003.md',
      to: '/private/secret.md',
      relation: 'explains',
      evidence: 'a public document reaching into the annex',
      actor: 'human:jimmy',
    });
    assert.ok(leak.startsWith('REJECTED') && leak.includes('private'), leak);

    const ok = await executeContract(wikiRelateContract, {
      from: '/decisions/0003.md',
      to: 'module:lib/wiki/lint.ts',
      relation: 'constrains',
      evidence: 'ADR 0003: "Closure (lint error): no document outside /private/ may link into it."',
      actor: 'human:jimmy',
    });
    assert.ok(ok.startsWith('ASSERTED'), ok);
    assert.ok(ok.includes('constrains'), ok);
    assert.ok(
      readFileSync(join(root, 'log.md'), 'utf-8').includes('relate |'),
      'a public assertion lands in the public log',
    );

    const again = await executeContract(wikiRelateContract, {
      from: '/decisions/0003.md',
      to: 'module:lib/wiki/lint.ts',
      relation: 'constrains',
      evidence: 'ADR 0003: "Closure (lint error): no document outside /private/ may link into it."',
      actor: 'human:jimmy',
    });
    assert.ok(again.startsWith('UNCHANGED'), again);

    const priv = await executeContract(wikiRelateContract, {
      from: '/private/secret.md',
      to: 'module:lib/wiki/lint.ts',
      relation: 'depends_on',
      evidence: 'the annex may point outward',
      actor: 'human:jimmy',
    });
    assert.ok(priv.startsWith('ASSERTED'), priv);
    assert.ok(
      !readFileSync(join(root, 'log.md'), 'utf-8').includes('/private/secret.md'),
      'the public log never names private knowledge',
    );
    assert.ok(
      readFileSync(join(root, 'private/log.md'), 'utf-8').includes('/private/secret.md'),
      'the annex keeps its own log',
    );

    const census = await executeContract(wikiGraphContract, { find: 'lint' });
    assert.ok(census.includes('module:lib/wiki/lint.ts'), census);
  } finally {
    delete process.env.WIKI_ROOT;
    rmSync(root, { recursive: true, force: true });
  }
});
