/**
 * lib/tools/wikiTools.ts — the wiki's tool surface, defined once.
 *
 * WHY this file exists:
 *   Everything an agent (or MCP client) can DO with the knowledge bundle is
 *   a ToolContract here — zod schema single source of truth, derived into
 *   ADK FunctionTools for syndicate agents and MCP definitions for outside
 *   clients, exactly like the rest of lib/tools.
 *
 *   Three capability tiers, deliberately separated:
 *
 *   NAVIGATE (wiki_map, wiki_read, wiki_search, wiki_links, wiki_dive,
 *     wiki_graph) — pure functions over the bundle. No model, no writes,
 *     instant. These are what "repo dive" means: an agent on a knowledge
 *     task orients, searches, follows links, and gets an ordered reading
 *     plan. wiki_graph adds the second layer — the ENTITY graph of agents,
 *     tools, models, modules, tables and env vars derived from repo truth
 *     (lib/wiki/entities.ts) — which answers relational questions no
 *     amount of document search can ("who calls this tool").
 *
 *   WRITE (wiki_save, wiki_relate) — the only two write paths, both gated.
 *     wiki_save: parse → profile validation → lint (errors block,
 *     including the private-closure rule) → path-jailed write → directory
 *     index refresh → log.md entry. wiki_relate: one asserted relation,
 *     refused unless the relation is an INFERRED one (structural relations
 *     are derived by the build), both endpoints exist, no public document
 *     points into the private annex, and evidence is supplied. Agents
 *     cannot corrupt the bundle through either door; the worst they can do
 *     is write mediocre prose, which lint's warnings surface and git can
 *     revert.
 *
 *   AGENTIC (wiki_query, wiki_garden) — composites that put a model in
 *     the loop, running a one-shot agent equipped with the tier-1 (and for
 *     garden, tier-2) tools. Exposed so an MCP client can ask the wiki a
 *     question or delegate an edit as ONE call.
 *
 *   Exposure stays deliberate (the registry/server decide); defining these
 *   contracts publishes nothing by itself.
 */

import { z } from 'zod';

import { WIKI_AGENT_MODEL } from '../config.ts';
import { runWikiAgent } from '../wiki/agentRun.ts';
import { appendLog, indexSpec, upsertDoc } from '../wiki/builder.ts';
import { repoDive, scoreDocs } from '../wiki/dive.ts';
import {
  actorSchema,
  BUILD_ACTOR,
  CONCEPT_TYPES,
  isPrivatePath,
  isReservedFilename,
  trustTier,
} from '../wiki/format.ts';
import {
  edgeKey,
  entityStats,
  findNodes,
  isPrivateNode,
  loadEntityGraph,
  loadRelations,
  neighbors,
  nodesOfKind,
  NODE_KINDS,
  RELATIONS,
  relationsByTier,
  saveRelations,
  shortestPath,
  snapshotDrift,
  type EntityNode,
  type LoadedGraph,
} from '../wiki/entities.ts';
import { buildGraph, graphStats, neighborhood } from '../wiki/graph.ts';
import { formatLintReport, lintDoc, lintVault } from '../wiki/lint.ts';
import { sectionSlice } from '../wiki/markdown.ts';
import {
  docsInDirectory,
  jailedAbsPath,
  loadVault,
  lookupTarget,
  makeWikiDoc,
  resolveLinkTarget,
  resolveWikiRoot,
  writeDocFile,
  type Vault,
  type WikiDoc,
} from '../wiki/vault.ts';
import { defineTool, toFunctionTool, type ToolContract } from './toolContract.ts';

// ── Shared helpers ───────────────────────────────────────────────────────────

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function wikiModel(override?: string): string {
  return override ?? process.env.WIKI_AGENT_MODEL ?? WIKI_AGENT_MODEL;
}

/** Every execute() loads fresh — the bundle on disk is the only truth. */
function vaultOrError(): Vault | string {
  try {
    return loadVault(resolveWikiRoot());
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Which log an entry belongs in. `log.md` at the bundle root EXPORTS, so an
 * entry naming a private document or a private entity would leak exactly
 * what the private annex exists to withhold; those go to the annex's own
 * log instead, which the export never copies.
 */
function logTargetFor(privateTouched: boolean): string {
  return privateTouched ? '/private/log.md' : '/log.md';
}

function normalizeDocPath(raw: string): string {
  let path = raw.trim();
  if (!path.startsWith('/')) path = `/${path}`;
  return path;
}

function docSummaryLine(doc: WikiDoc): string {
  const desc = doc.fm?.description ? ` — ${doc.fm.description}` : '';
  return `${doc.bundlePath} · ${doc.title} [${doc.fm?.type ?? doc.kind}]${desc}`;
}

function navigationFooter(vault: Vault, doc: WikiDoc): string {
  const graph = buildGraph(vault);
  const out = (graph.outbound.get(doc.bundlePath) ?? [])
    .filter((e) => e.resolved)
    .map((e) => e.target);
  const inn = (graph.inbound.get(doc.bundlePath) ?? []).map((e) => e.source);
  const fmt = (paths: string[]): string =>
    paths.length > 0 ? [...new Set(paths)].join(', ') : '(none)';
  return `— navigation —\nlinks out: ${fmt(out)}\nlinked from: ${fmt(inn)}`;
}

// ── NAVIGATE ─────────────────────────────────────────────────────────────────

export const wikiMapContract = defineTool({
  name: 'wiki_map',
  description:
    'Orient in the knowledge bundle: its purpose, directory map, document census, and graph health. Call this FIRST on any knowledge task, then follow with wiki_search, wiki_read, or wiki_dive.',
  schema: z.object({}),
  execute: async () => {
    const vault = vaultOrError();
    if (typeof vault === 'string') return vault;
    const graph = buildGraph(vault);
    const stats = graphStats(graph);

    const rootIndex = vault.docs.get('/index.md');
    const lines: string[] = [];
    if (rootIndex) {
      const fm = rootIndex.parsed.frontmatter;
      lines.push(
        `${String(fm?.title ?? 'Knowledge bundle')} — ${String(fm?.description ?? '')}`.trim(),
      );
    }
    lines.push(
      `documents: ${stats.documents} (${stats.concepts} concepts) · links: ${stats.edges} · words: ${stats.totalWords}`,
      `health: ${stats.brokenLinks} broken link(s), ${stats.orphans} orphan(s)`,
      `types: ${Object.entries(stats.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}(${n})`)
        .join(', ')}`,
      '',
      'directories:',
    );
    const dirs = new Map<string, number>();
    for (const doc of vault.docs.values()) {
      const top = doc.bundlePath.split('/')[1];
      if (doc.bundlePath.split('/').length > 2) {
        dirs.set(top, (dirs.get(top) ?? 0) + 1);
      }
    }
    for (const [dir, count] of [...dirs.entries()].sort()) {
      const index = vault.docs.get(`/${dir}/index.md`);
      const h1 = index?.parsed.headings.find((h) => h.depth === 1)?.text ?? dir;
      lines.push(`  /${dir}/ — ${h1} (${count} file(s))`);
    }
    const entities = loadEntityGraph(resolveWikiRoot());
    if (entities.snapshot) {
      const eStats = entityStats(entities.graph);
      lines.push(
        '',
        `entity graph: ${eStats.nodes} nodes / ${eStats.edges} typed relations (${eStats.byTier.inferred} asserted) — query with wiki_graph`,
      );
    }
    lines.push('', 'read /index.md for the annotated map; log.md for recent changes.');
    return lines.join('\n');
  },
});

export const wikiReadContract = defineTool({
  name: 'wiki_read',
  description:
    'Read one wiki document by bundle path (e.g. "/memory/schema.md"), or one section of it. Returns frontmatter, content, and the links in and out — follow those paths for context.',
  schema: z.object({
    path: z.string().min(1).describe('Bundle-absolute path like /memory/schema.md'),
    section: z
      .string()
      .optional()
      .describe('Optional heading name or slug to read just that section'),
  }),
  execute: async ({ path, section }) => {
    const vault = vaultOrError();
    if (typeof vault === 'string') return vault;
    const resolved = resolveLinkTarget('/', normalizeDocPath(path));
    if (resolved.kind !== 'internal') {
      return `Error: not a bundle path: ${path}`;
    }
    const doc = lookupTarget(vault, resolved.bundlePath);
    if (!doc) {
      const near = scoreDocs(vault, path.replace(/[/_.-]/g, ' ')).slice(0, 3);
      return `Error: no document at ${resolved.bundlePath}.${
        near.length > 0
          ? ` Nearest matches:\n${near.map((n) => docSummaryLine(n.doc)).join('\n')}`
          : ''
      }`;
    }

    const header = [
      `path: ${doc.bundlePath}`,
      `title: ${doc.title}`,
      `type: ${doc.fm?.type ?? doc.kind} · status: ${doc.fm?.status ?? 'stable'} · trust: ${
        doc.fm ? trustTier(doc.fm) : 'unverified'
      } · words: ${doc.wordCount}`,
    ].join('\n');

    let content: string;
    if (section) {
      const slice = sectionSlice(doc.parsed, section);
      if (!slice) {
        return `Error: no section "${section}" in ${doc.bundlePath}. Sections: ${doc.parsed.headings
          .map((h) => h.slug)
          .join(', ')}`;
      }
      content = slice.text;
    } else {
      content = doc.parsed.raw;
    }
    const MAX = 40_000;
    if (content.length > MAX) {
      content = `${content.slice(0, MAX)}\n…[truncated — use the section parameter]`;
    }
    return `${header}\n\n${content}\n\n${navigationFooter(vault, doc)}`;
  },
});

export const wikiSearchContract = defineTool({
  name: 'wiki_search',
  description:
    'Lexical search over the knowledge bundle (titles, tags, headings, paths, body). Returns ranked bundle paths with snippets — read the winners with wiki_read.',
  schema: z.object({
    query: z.string().min(2).describe('Search terms'),
    limit: z.number().int().min(1).max(25).default(8),
  }),
  execute: async ({ query, limit }) => {
    const vault = vaultOrError();
    if (typeof vault === 'string') return vault;
    const results = scoreDocs(vault, query).slice(0, limit);
    if (results.length === 0) {
      return `No matches for "${query}". Try wiki_map for the directory census, or broaden the terms.`;
    }
    return results
      .map(
        (r, i) =>
          `${i + 1}. ${docSummaryLine(r.doc)}\n   score ${r.score} (${r.matched.join(', ')})${
            r.snippet ? `\n   "${r.snippet}"` : ''
          }`,
      )
      .join('\n');
  },
});

export const wikiLinksContract = defineTool({
  name: 'wiki_links',
  description:
    'Walk the knowledge graph from one document: what it links to and what links to it, out to a chosen depth. Use to find related concepts search terms would miss.',
  schema: z.object({
    path: z.string().min(1).describe('Bundle-absolute path of the origin document'),
    depth: z.number().int().min(1).max(3).default(1),
    direction: z.enum(['out', 'in', 'both']).default('both'),
  }),
  execute: async ({ path, depth, direction }) => {
    const vault = vaultOrError();
    if (typeof vault === 'string') return vault;
    const resolved = resolveLinkTarget('/', normalizeDocPath(path));
    if (resolved.kind !== 'internal') return `Error: not a bundle path: ${path}`;
    const doc = lookupTarget(vault, resolved.bundlePath);
    if (!doc) return `Error: no document at ${resolved.bundlePath}`;
    const graph = buildGraph(vault);
    const neighbors = neighborhood(graph, doc.bundlePath, depth, direction);
    if (neighbors.length === 0) {
      return `${doc.bundlePath} has no ${direction === 'both' ? '' : `${direction}bound `}links within depth ${depth} — it may be an orphan; consider gardening.`;
    }
    return [
      `neighborhood of ${doc.bundlePath} (depth ${depth}, ${direction}):`,
      ...neighbors.map(
        (n) =>
          `  ${'·'.repeat(n.distance)} ${n.node.path} · ${n.node.title} [${n.node.type}] (${
            n.direction === 'out' ? '→' : '←'
          } via ${n.via})`,
      ),
    ].join('\n');
  },
});

export const wikiDiveContract = defineTool({
  name: 'wiki_dive',
  description:
    'Repo dive: given a TASK, get an ordered reading plan through the bundle — orientation indexes first, then matched concepts, then graph-linked context, within a word budget. Deterministic and instant; do the reading with wiki_read.',
  schema: z.object({
    task: z
      .string()
      .min(3)
      .describe('The knowledge task, e.g. "add a new provider adapter"'),
    budget_words: z.number().int().min(500).max(50_000).default(6000),
  }),
  execute: async ({ task, budget_words }) => {
    const vault = vaultOrError();
    if (typeof vault === 'string') return vault;
    const plan = repoDive(vault, task, budget_words);
    if (plan.stops.length === 0) {
      return `No relevant documents found for "${task}". The bundle may not cover this yet — wiki_map shows what exists.`;
    }
    const lines = [
      `reading plan for: ${plan.task}`,
      `${plan.stops.length} stop(s), ~${plan.totalWords} words (budget ${plan.budgetWords})`,
      '',
      ...plan.stops.map(
        (s) =>
          `${s.order}. [${s.role}] ${s.path} · ${s.title} (~${s.wordCount}w)\n   why: ${s.reason}`,
      ),
    ];
    if (plan.overflow.length > 0) {
      lines.push(
        '',
        `did not fit the budget: ${plan.overflow.map((o) => o.path).join(', ')}`,
      );
    }
    return lines.join('\n');
  },
});

// ── NAVIGATE: the entity layer ───────────────────────────────────────────────

/** Snapshot + asserted relations, or a message explaining what to run. */
function entityGraphOrError(): LoadedGraph | string {
  const loaded = loadEntityGraph(resolveWikiRoot());
  if (!loaded.snapshot) {
    return 'Error: no entity graph snapshot in this bundle (.graph/graph.json). It is derived from repo truth by the build — run `npm run wiki:build`. Document-only navigation (wiki_links) works without it.';
  }
  return loaded;
}

function describeNode(node: EntityNode): string {
  const attrs = Object.entries(node.attrs ?? {})
    .filter(([key]) => key !== 'description')
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' · ');
  const description = node.attrs?.description ? ` — ${String(node.attrs.description)}` : '';
  return `${node.id} [${node.kind}]${node.private ? ' (private)' : ''}${
    attrs ? ` {${attrs}}` : ''
  }${description}`;
}

function stalenessNote(loaded: LoadedGraph): string | null {
  let vault: Vault | string;
  try {
    vault = loadVault(resolveWikiRoot());
  } catch {
    return null;
  }
  if (typeof vault === 'string') return null;
  const current = [...vault.docs.values()]
    .filter((d) => d.kind === 'concept')
    .map((d) => d.bundlePath);
  const drift = snapshotDrift(loaded.snapshot, current);
  if (drift.missing.length === 0 && drift.removed.length === 0) return null;
  const parts: string[] = [];
  if (drift.missing.length > 0) parts.push(`${drift.missing.length} document(s) added since`);
  if (drift.removed.length > 0) parts.push(`${drift.removed.length} removed`);
  return `snapshot is stale (${parts.join(', ')}) — run \`npm run wiki:build\` to refresh it.`;
}

export const wikiGraphContract = defineTool({
  name: 'wiki_graph',
  description:
    'Query the ENTITY graph: agents, syndicates, models, providers, tools, MCP servers, modules, tables, env vars, npm scripts and documents, joined by typed relations (uses_tool, uses_model, imports, reads_table, requires_env, documents, depends_on, constrains…). Answers what search cannot: which syndicates call a tool, what breaks without a key, how two things connect. No arguments = census. Use `find` when you do not know a node id.',
  schema: z.object({
    node: z
      .string()
      .optional()
      .describe('Node to centre on: "tool:web_search", "agent:critic/DrafterAgent", "/memory/schema.md"'),
    find: z.string().optional().describe('Lexical node search when the exact id is unknown'),
    kind: z
      .string()
      .optional()
      .describe('List every node of one kind: agent, syndicate, model, provider, tool, mcp-server, module, file, table, env, script, doc, external'),
    path_to: z
      .string()
      .optional()
      .describe('With `node`: the shortest chain of relations joining the two'),
    relations: z
      .array(z.string())
      .optional()
      .describe('Restrict the walk to these relation ids'),
    depth: z.number().int().min(1).max(3).default(1),
    direction: z.enum(['out', 'in', 'both']).default('both'),
    limit: z.number().int().min(1).max(200).default(40),
  }),
  execute: async ({ node, find, kind, path_to, relations, depth, direction, limit }) => {
    const loaded = entityGraphOrError();
    if (typeof loaded === 'string') return loaded;
    const { graph } = loaded;
    const stale = stalenessNote(loaded);
    const footer = [
      stale ? `\nnote: ${stale}` : '',
      loaded.issues.length > 0 ? `\nrelation store issues: ${loaded.issues.join('; ')}` : '',
    ].join('');

    if (find) {
      const matches = findNodes(graph, find, limit);
      if (matches.length === 0) {
        return `No node matches "${find}". Try wiki_graph with no arguments for the census of kinds.${footer}`;
      }
      return [
        `nodes matching "${find}":`,
        ...matches.map((m) => `  ${describeNode(m.node)}`),
      ].join('\n') + footer;
    }

    if (kind) {
      const list = nodesOfKind(graph, kind);
      if (list.length === 0) {
        return `No nodes of kind "${kind}". Kinds present: ${Object.keys(entityStats(graph).byKind).sort().join(', ')}${footer}`;
      }
      return [
        `${list.length} ${kind} node(s):`,
        ...list.slice(0, limit).map((n) => `  ${describeNode(n)}`),
        ...(list.length > limit ? [`  …${list.length - limit} more (raise limit)`] : []),
      ].join('\n') + footer;
    }

    if (node && path_to) {
      const from = graph.nodes.get(node) ?? findNodes(graph, node, 1)[0]?.node;
      const to = graph.nodes.get(path_to) ?? findNodes(graph, path_to, 1)[0]?.node;
      if (!from) return `Error: no node "${node}" — try wiki_graph with find.${footer}`;
      if (!to) return `Error: no node "${path_to}" — try wiki_graph with find.${footer}`;
      const chain = shortestPath(graph, from.id, to.id);
      if (!chain) {
        return `No relation chain connects ${from.id} and ${to.id} within 6 hops.${footer}`;
      }
      return [
        `${from.id} → ${to.id} (${chain.length - 1} hop(s)):`,
        ...chain.map((step, i) =>
          i === 0
            ? `  ${step.node.id}`
            : `  ${step.direction === 'out' ? '—' : '←'}${step.rel}${
                step.direction === 'out' ? '→' : '—'
              } ${step.node.id} [${step.node.kind}]`,
        ),
      ].join('\n') + footer;
    }

    if (node) {
      const origin = graph.nodes.get(node) ?? findNodes(graph, node, 1)[0]?.node;
      if (!origin) {
        const near = findNodes(graph, node, 5);
        return `Error: no node "${node}".${
          near.length > 0 ? ` Nearest:\n${near.map((n) => `  ${describeNode(n.node)}`).join('\n')}` : ''
        }${footer}`;
      }
      const steps = neighbors(graph, origin.id, { depth, direction, ...(relations ? { relations } : {}) });
      if (steps.length === 0) {
        return `${describeNode(origin)}\n  no ${direction === 'both' ? '' : `${direction}bound `}relations within depth ${depth}.${footer}`;
      }
      const grouped = new Map<string, string[]>();
      for (const step of steps.slice(0, limit)) {
        const spec = RELATIONS[step.rel];
        const heading = `${step.direction === 'out' ? `—${step.rel}→` : `←${step.rel}—`} (${
          spec ? spec.phrase : step.rel
        }, ${step.tier})`;
        const line = `    ${step.node.id} [${step.node.kind}]${
          step.distance > 1 ? ` · ${step.distance} hops via ${step.via}` : ''
        }${step.tier === 'inferred' && step.evidence ? `\n      evidence: ${step.evidence}` : ''}`;
        grouped.set(heading, [...(grouped.get(heading) ?? []), line]);
      }
      return [
        describeNode(origin),
        ...[...grouped.entries()].sort().flatMap(([heading, lines]) => [`  ${heading}`, ...lines]),
        ...(steps.length > limit ? [`  …${steps.length - limit} more relation(s)`] : []),
      ].join('\n') + footer;
    }

    const stats = entityStats(graph);
    return [
      `entity graph — built ${loaded.snapshot?.generated.at ?? '?'} by ${loaded.snapshot?.generated.by ?? '?'}`,
      `${stats.nodes} nodes, ${stats.edges} relations (${stats.byTier.extracted} extracted from repo truth, ${stats.byTier.inferred} asserted with evidence)`,
      '',
      'kinds:',
      ...Object.entries(stats.byKind)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `  ${k} (${n}) — ${NODE_KINDS[k] ?? 'unknown kind'}`),
      '',
      'relations:',
      ...Object.entries(stats.byRelation)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `  ${r} (${n}) — ${RELATIONS[r]?.gloss ?? 'outside the vocabulary'}`),
      '',
      'centre on a node with `node`, or search with `find`.',
    ].join('\n') + footer;
  },
});

// ── WRITE: assert a relation the build cannot derive ─────────────────────────

export const wikiRelateContract = defineTool({
  name: 'wiki_relate',
  description:
    'Assert ONE typed relation the build cannot derive — a judgment read out of prose (depends_on, constrains, supersedes, explains, alternative_to, mitigates, contradicts). Requires evidence: quote the text or name the file that says so. Structural relations (uses_tool, imports…) are refused: those are derived by `npm run wiki:build` and asserting them would rot.',
  schema: z.object({
    from: z.string().min(1).describe('Source node id, e.g. "/decisions/0003-path-based-visibility.md"'),
    to: z.string().min(1).describe('Target node id, e.g. "module:scripts/export-public/export.sh"'),
    relation: z
      .string()
      .min(1)
      .describe('One of: depends_on, constrains, supersedes, explains, alternative_to, mitigates, contradicts'),
    evidence: z
      .string()
      .min(10)
      .describe('Why this holds: a quotation from the document, or the path that states it'),
    actor: actorSchema.describe('"human:<id>", "process:<id>", or "<producer>/<model>"'),
    note: z.string().optional().describe('Optional clarification for a later reader'),
  }),
  execute: async ({ from, to, relation, evidence, actor, note }) => {
    const root = resolveWikiRoot();
    const loaded = entityGraphOrError();
    if (typeof loaded === 'string') return loaded;
    const { graph } = loaded;

    const spec = RELATIONS[relation];
    if (!spec) {
      return `REJECTED — "${relation}" is not in the vocabulary. Assertable relations: ${relationsByTier(
        'inferred',
      ).join(', ')}.`;
    }
    if (spec.tier !== 'inferred') {
      return `REJECTED — "${relation}" is an EXTRACTED relation: the build derives it from repo truth on every run, so an assertion would go stale silently. Change the source of truth instead, then run \`npm run wiki:build\`.`;
    }

    const resolveEnd = (id: string): EntityNode | null =>
      graph.nodes.get(id) ?? (findNodes(graph, id, 1)[0]?.node ?? null);
    const fromNode = resolveEnd(from);
    const toNode = resolveEnd(to);
    for (const [label, raw, resolved] of [
      ['from', from, fromNode],
      ['to', to, toNode],
    ] as const) {
      if (!resolved) {
        const near = findNodes(graph, raw, 5);
        return [
          `REJECTED — no node "${raw}" (${label}).`,
          near.length > 0
            ? `Nearest:\n${near.map((n) => `  ${describeNode(n.node)}`).join('\n')}`
            : 'Use wiki_graph with `find` or `kind` to see what exists.',
        ].join('\n');
      }
    }
    if (fromNode!.id === toNode!.id) {
      return `REJECTED — a node cannot relate to itself (${fromNode!.id}).`;
    }
    if (fromNode!.kind === 'doc' && !isPrivateNode(fromNode!) && isPrivateNode(toNode!)) {
      return `REJECTED — ${fromNode!.id} is a public document and ${toNode!.id} is private knowledge. Public documents never point into the private annex; move the claim to a /private/ document instead.`;
    }

    const { records } = loadRelations(root);
    const key = edgeKey({ from: fromNode!.id, rel: relation, to: toNode!.id });
    if (records.some((r) => edgeKey(r) === key)) {
      return `UNCHANGED — ${key} is already asserted. wiki_graph on either node shows it.`;
    }

    const record = {
      from: fromNode!.id,
      to: toNode!.id,
      rel: relation,
      evidence,
      by: actor,
      at: todayIso(),
      ...(note ? { note } : {}),
    };
    saveRelations(root, [...records, record]);
    appendLog(
      root,
      todayIso(),
      'relate',
      `${fromNode!.id} —${relation}→ ${toNode!.id}`,
      `by ${actor}`,
      logTargetFor(isPrivateNode(fromNode!) || isPrivateNode(toNode!)),
    );

    const reverse = records.find(
      (r) => r.from === toNode!.id && r.to === fromNode!.id && r.rel === relation,
    );
    return [
      `ASSERTED ${fromNode!.id} —${relation}→ ${toNode!.id} · logged to /log.md`,
      `reads: ${fromNode!.label} ${RELATIONS[relation].phrase} ${toNode!.label}`,
      reverse ? `advisory: the reverse (${edgeKey(reverse)}) is also asserted — one direction is usually enough.` : 'advisories: none',
    ].join('\n');
  },
});

// ── WRITE ────────────────────────────────────────────────────────────────────

export const wikiSaveContract = defineTool({
  name: 'wiki_save',
  description:
    'Write one concept document into the bundle (create or revise). The draft must be complete markdown with YAML frontmatter (`type` required). Validation gates the write: lint errors REJECT it; the directory index and log.md update automatically. Reserved files (index.md, log.md) cannot be written.',
  schema: z.object({
    path: z
      .string()
      .min(4)
      .describe('Bundle-absolute target like /decisions/0005-topic.md'),
    content: z
      .string()
      .min(20)
      .describe('Full document text: --- frontmatter --- then markdown body'),
    actor: actorSchema.describe(
      'Who authored this: "human:<id>", "process:<id>", or "<producer>/<model>"',
    ),
    summary: z
      .string()
      .min(5)
      .max(200)
      .describe('One-line change summary for log.md'),
  }),
  execute: async ({ path, content, actor, summary }) => {
    const vault = vaultOrError();
    if (typeof vault === 'string') return vault;

    const bundlePath = normalizeDocPath(path);
    if (!bundlePath.endsWith('.md')) {
      return `Error: documents are .md files: ${bundlePath}`;
    }
    const fileName = bundlePath.split('/').pop() ?? '';
    if (isReservedFilename(fileName)) {
      return `Error: ${fileName} is reserved and machine-maintained — write concept documents only.`;
    }
    let absPath: string;
    try {
      absPath = jailedAbsPath(vault.root, bundlePath);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    // Evaluate the draft exactly as the bundle would see it.
    const draft = makeWikiDoc(bundlePath, absPath, content);
    const existed = vault.docs.has(bundlePath);
    vault.docs.set(bundlePath, draft);
    const findings = lintDoc(vault, draft);
    const errors = findings.filter((f) => f.severity === 'error');
    if (errors.length > 0) {
      return [
        `REJECTED — fix these and save again:`,
        ...errors.map((e) => `  ${e.rule}${e.line ? `:${e.line}` : ''} — ${e.message}`),
        '',
        `Profile: frontmatter needs non-empty \`type\` (vocabulary: ${CONCEPT_TYPES.join(', ')});`,
        'links are bundle-absolute markdown links; public docs never link into /private/.',
      ].join('\n');
    }

    const today = todayIso();
    writeDocFile(vault.root, bundlePath, content);

    // Structural aftermath: refresh the directory index, append the log.
    const dir = bundlePath.slice(0, bundlePath.lastIndexOf('/') + 1);
    if (dir !== '/') {
      const siblings = docsInDirectory(vault, dir)
        .filter((d) => d.kind === 'concept')
        .map((d) => ({
          bundlePath: d.bundlePath,
          title: d.title,
          description: String(d.fm?.description ?? d.fm?.type ?? 'concept'),
        }))
        .sort((a, b) => a.bundlePath.localeCompare(b.bundlePath));
      const indexTitle =
        vault.docs.get(`${dir}index.md`)?.parsed.headings.find((h) => h.depth === 1)
          ?.text ?? dir.replaceAll('/', ' ').trim();
      upsertDoc(vault.root, indexSpec(dir, indexTitle, siblings), {
        actor: BUILD_ACTOR,
        date: today,
      });
    }
    appendLog(
      vault.root,
      today,
      'garden',
      `${summary} (${bundlePath})`,
      `by ${actor}`,
      logTargetFor(isPrivatePath(bundlePath)),
    );

    const warnings = findings.filter((f) => f.severity !== 'error');
    return [
      `${existed ? 'REVISED' : 'CREATED'} ${bundlePath} (${draft.wordCount} words) · logged to /log.md`,
      warnings.length > 0
        ? `advisories:\n${warnings.map((w) => `  ${w.rule} — ${w.message}`).join('\n')}`
        : 'advisories: none',
    ].join('\n');
  },
});

// ── AGENTIC ──────────────────────────────────────────────────────────────────

const NAVIGATE_CONTRACTS = [
  wikiMapContract,
  wikiReadContract,
  wikiSearchContract,
  wikiLinksContract,
  wikiDiveContract,
  wikiGraphContract,
] as const;

export const wikiQueryContract = defineTool({
  name: 'wiki_query',
  description:
    'Ask the knowledge bundle a question in natural language. An agent navigates the wiki (map → search → read → links) and answers with bundle-path citations. Costs a model call; for raw lookup prefer wiki_search/wiki_read.',
  schema: z.object({
    question: z.string().min(5),
    model: z
      .string()
      .optional()
      .describe('Override model (any provider string the registry routes)'),
  }),
  execute: async ({ question, model }) => {
    const result = await runWikiAgent({
      name: 'wiki_librarian',
      description: 'Answers questions from the knowledge bundle, with citations.',
      model: wikiModel(model),
      instruction: `You answer questions using ONLY the knowledge bundle reachable through your wiki tools.
Method: wiki_map to orient, then wiki_search (and wiki_links from strong hits), then wiki_read the few most relevant documents. THEN answer.
Rules:
- Everything you assert must come from documents you actually read this run; if the bundle does not cover it, say so plainly.
- Answer first, provenance second: end with "Sources:" listing the bundle paths you drew on.
- Note trust when it matters: an unverified or draft document is a weaker source than a human-reviewed one.
- Be concrete and brief. No filler.`,
      userText: question,
      tools: NAVIGATE_CONTRACTS.map(toFunctionTool),
      temperature: 0.2,
      maxOutputTokens: 4096,
    });
    if (result.error) return `Error: wiki_query failed: ${result.error}`;
    return result.text === '' ? 'Error: wiki_query produced no answer.' : result.text;
  },
});

export const wikiGardenContract = defineTool({
  name: 'wiki_garden',
  description:
    'Delegate a wiki edit to a gardener agent: author a new concept document or revise existing ones from an instruction. The agent reads relevant docs first, then writes through the validated wiki_save gate and reports exactly what changed. Costs model calls.',
  schema: z.object({
    instruction: z
      .string()
      .min(10)
      .describe(
        'What to plant or prune, e.g. "document the retry doctrine decided today: <details>"',
      ),
    model: z.string().optional(),
  }),
  execute: async ({ instruction, model }) => {
    const resolvedModel = wikiModel(model);
    const result = await runWikiAgent({
      name: 'wiki_gardener',
      description: 'Authors and revises knowledge bundle documents.',
      model: resolvedModel,
      instruction: `You garden a knowledge bundle: plant new concept documents and prune existing ones.
Method — always in this order:
1. wiki_map, then wiki_search/wiki_read to find where the topic lives today. Revise the existing document rather than planting a duplicate.
2. Draft the full document: YAML frontmatter, then body.
3. wiki_save it. If REJECTED, fix every listed error and save again. Report the advisories you accept.
Format profile:
- frontmatter: \`type\` REQUIRED — vocabulary: ${CONCEPT_TYPES.join(', ')}; plus title, description, tags; keep any existing status/verified fields when revising.
- links: bundle-absolute markdown links like [Memory schema](/memory/schema.md), ONLY to paths you confirmed exist (wiki_search/wiki_read). Link generously — the graph is the product.
- body: H1 title, then short sections. Plain, concrete, present tense. State facts you were given or read in the bundle; never invent.
- private knowledge lives under /private/ — public documents never link there.
Save with actor "melchizedek/${resolvedModel}". After saving, summarize: paths written, what changed, advisories.`,
      userText: instruction,
      tools: [...NAVIGATE_CONTRACTS, wikiSaveContract].map(toFunctionTool),
      temperature: 0.4,
      maxOutputTokens: 8192,
    });
    if (result.error) return `Error: wiki_garden failed: ${result.error}`;
    return result.text === '' ? 'Error: wiki_garden produced no report.' : result.text;
  },
});

// ── Rollups (exposure still happens elsewhere) ───────────────────────────────

/** Everything an MCP client may be offered (see the wiki MCP server script). */
export const WIKI_TOOL_CONTRACTS: readonly ToolContract<any>[] = [
  ...NAVIGATE_CONTRACTS,
  wikiSaveContract,
  wikiRelateContract,
  wikiQueryContract,
  wikiGardenContract,
];

/**
 * What syndicate agents may declare in YAML (via lib/toolRegistry.ts).
 * The agentic composites are excluded on purpose: a syndicate reaches
 * query/garden behavior by BEING the agent with these primitives, not by
 * nesting another agent run inside a tool call.
 */
export const WIKI_AGENT_TOOL_CONTRACTS: readonly ToolContract<any>[] = [
  ...NAVIGATE_CONTRACTS,
  wikiSaveContract,
  wikiRelateContract,
];

/** Lint the whole bundle — shared by the build script and tests. */
export function lintWholeVault(): string {
  const vault = vaultOrError();
  if (typeof vault === 'string') return vault;
  return formatLintReport(lintVault(vault));
}

/** Census helper for scripts (not a tool): concepts + word count. */
export function vaultCensus(): string {
  const vault = vaultOrError();
  if (typeof vault === 'string') return vault;
  const stats = graphStats(buildGraph(vault));
  return `${stats.documents} documents, ${stats.concepts} concepts, ${stats.edges} links, ${stats.totalWords} words`;
}
