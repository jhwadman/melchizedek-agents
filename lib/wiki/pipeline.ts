/**
 * lib/wiki/pipeline.ts — the parts of a build every bundle shares.
 *
 * WHY this file exists:
 *   A bundle's build script is supposed to be small and entirely about ONE
 *   repo: which files are the truth, and what documents derive from them.
 *   Everything around that is identical wherever the engine runs —
 *   deriving the entity graph, merging the asserted relations, writing the
 *   snapshot, linting it, reporting the census, and the document that
 *   publishes the graph vocabulary. Those live here so a second and third
 *   bundle cost a page of repo-specific mapping instead of a copied
 *   pipeline that immediately starts to drift.
 *
 *   The repo-specific half arrives as an EntityLayer: nodes and edges the
 *   caller extracted from its own truth. This module never guesses what a
 *   repo contains.
 */

import {
  buildEntityGraph,
  entityStats,
  lintEntityGraph,
  loadRelations,
  NODE_KINDS,
  relationEdges,
  RELATIONS,
  writeSnapshot,
  type EntityEdge,
  type EntityGraph,
  type EntityNode,
  type EntityStats,
  type GraphFinding,
} from './entities.ts';
import { table } from './markdown.ts';
import type { DocSpec } from './builder.ts';

// ── The repo-specific input ──────────────────────────────────────────────────

export interface EntityLayer {
  nodes: EntityNode[];
  edges: EntityEdge[];
  /** Things the extractor noticed but could not resolve (typos, dead names). */
  warnings: string[];
}

export interface EntityPassResult {
  graph: EntityGraph;
  stats: EntityStats;
  findings: GraphFinding[];
  warnings: string[];
  inferred: number;
}

/**
 * Merge the derived layer with the asserted relations and (unless this is a
 * lint-only run) refresh the snapshot the wiki tools read. The snapshot
 * lives inside the bundle at `.graph/graph.json` — it travels with
 * WIKI_ROOT, the vault walker ignores dot-directories, and a markdown-only
 * export cannot ship it by accident.
 */
export function entityPass(options: {
  wikiRoot: string;
  layer: EntityLayer;
  actor: string;
  date: string;
  write: boolean;
}): EntityPassResult {
  const relations = loadRelations(options.wikiRoot);
  const graph = buildEntityGraph(options.layer.nodes, [
    ...options.layer.edges,
    ...relationEdges(relations.records),
  ]);
  if (options.write) {
    writeSnapshot(options.wikiRoot, graph, { by: options.actor, at: options.date });
  }
  return {
    graph,
    stats: entityStats(graph),
    findings: lintEntityGraph(graph),
    warnings: [...options.layer.warnings, ...relations.issues],
    inferred: relations.records.length,
  };
}

export function reportEntityPass(
  pass: EntityPassResult,
  log: (line: string) => void = console.log,
): void {
  const kinds = Object.entries(pass.stats.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind}(${n})`)
    .join(', ');
  log(
    `entities: ${pass.stats.nodes} nodes, ${pass.stats.edges} edges (${pass.stats.byTier.extracted} extracted, ${pass.stats.byTier.inferred} inferred), ${pass.stats.isolated} isolated`,
  );
  log(`  kinds: ${kinds}`);
  for (const warning of pass.warnings) log(`  warning: ${warning}`);
  const errors = pass.findings.filter((f) => f.severity === 'error');
  const others = pass.findings.filter((f) => f.severity !== 'error');
  for (const finding of [...errors, ...others].slice(0, 12)) {
    log(`  graph-${finding.severity}: ${finding.rule} — ${finding.message}`);
  }
  if (pass.findings.length > 12) {
    log(`  …and ${pass.findings.length - 12} more graph finding(s)`);
  }
}

export function graphErrorCount(pass: EntityPassResult): number {
  return pass.findings.filter((f) => f.severity === 'error').length;
}

// ── The document that publishes the vocabulary ───────────────────────────────

/**
 * The graph's own reference page: what kinds of node exist, what the
 * relations mean, and how many of each the bundle holds right now. Both
 * tables are machine-owned, so the vocabulary in the document can never
 * disagree with the vocabulary in the code. Prose around them belongs to
 * whoever writes it.
 */
export function graphDocSpec(options: {
  bundlePath: string;
  title: string;
  description: string;
  stats: EntityStats;
  sources: string[];
  /** Prose written into the document the first time it is created. */
  intro: string;
  /** Prose appended after the tables on creation. */
  outro: string;
  tags?: string[];
  /** Node kinds this bundle adds beyond the shared vocabulary, with glosses. */
  extraKinds?: Record<string, string>;
}): DocSpec {
  const vocabulary = { ...NODE_KINDS, ...(options.extraKinds ?? {}) };
  const kindRows = Object.entries(vocabulary)
    .sort((a, b) => (options.stats.byKind[b[0]] ?? 0) - (options.stats.byKind[a[0]] ?? 0))
    .map(([kind, gloss]) => [
      `\`${kind}\``,
      kind === 'doc' ? '`/dir/doc.md`' : `\`${kind}:<name>\``,
      String(options.stats.byKind[kind] ?? 0),
      gloss,
    ]);
  const relationRows = Object.entries(RELATIONS)
    .sort(
      (a, b) =>
        a[1].tier.localeCompare(b[1].tier) ||
        (options.stats.byRelation[b[0]] ?? 0) - (options.stats.byRelation[a[0]] ?? 0),
    )
    .map(([id, spec]) => [
      `\`${id}\``,
      spec.tier,
      `A ${spec.phrase} B`,
      String(options.stats.byRelation[id] ?? 0),
      spec.gloss,
    ]);

  return {
    bundlePath: options.bundlePath,
    fm: {
      type: 'meta',
      title: options.title,
      description: options.description,
      tags: options.tags ?? ['meta', 'graph'],
      sources: options.sources.map((resource) => ({ resource })),
    },
    body: [
      { kind: 'prose', markdown: options.intro },
      {
        kind: 'generated',
        id: 'node-kinds',
        source: 'lib/wiki/entities.ts',
        markdown: `## What the graph knows about\n\n${table(
          ['Kind', 'Id form', 'Now', 'What it is'],
          kindRows,
        )}\n\nA document keeps its bundle path as its identity, so the two namespaces cannot collide.`,
      },
      {
        kind: 'generated',
        id: 'relations',
        source: 'lib/wiki/entities.ts',
        markdown: `## The relation vocabulary\n\n${table(
          ['Relation', 'Tier', 'Reads as', 'Now', 'Meaning'],
          relationRows,
        )}`,
      },
      { kind: 'prose', markdown: options.outro },
    ],
  };
}
