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
 *   NAVIGATE (wiki_map, wiki_read, wiki_search, wiki_links, wiki_dive) —
 *     pure functions over the bundle. No model, no writes, instant. These
 *     are what "repo dive" means: an agent on a knowledge task orients,
 *     searches, follows links, and gets an ordered reading plan.
 *
 *   WRITE (wiki_save) — the ONLY write path, and it is gated: parse →
 *     profile validation → lint (errors block, including the private-
 *     closure rule) → path-jailed write → directory index refresh →
 *     log.md entry. Agents cannot corrupt the bundle through this door;
 *     the worst they can do is write mediocre prose, which lint's
 *     warnings surface and git can revert.
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
  isReservedFilename,
  trustTier,
} from '../wiki/format.ts';
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
    appendLog(vault.root, today, 'garden', `${summary} (${bundlePath})`, `by ${actor}`);

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
