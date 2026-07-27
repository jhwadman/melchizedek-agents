/**
 * lib/wiki/dive.ts — search scoring and "repo dive" reading paths.
 *
 * WHY this file exists:
 *   The two navigation questions an agent asks a wiki are "which documents
 *   mention X?" (search) and "I have a TASK — what should I read, in what
 *   order, within a budget?" (dive). Both are answered here with plain
 *   lexical scoring plus graph propagation — deliberately NO model call and
 *   NO embeddings: navigation must be instant, deterministic, and free, so
 *   an agent can call it dozens of times while working. Semantic answering
 *   belongs to wiki_query (an agent using these primitives), not here.
 *
 *   Dive = scored seeds + link expansion. Seeds are the best lexical
 *   matches; the knowledge graph then pulls in what the seeds are wired to
 *   (score decaying with link distance), because in a well-gardened bundle
 *   PROXIMITY IN THE GRAPH IS RELEVANCE. The result is an ordered reading
 *   plan — orientation first (indexes), then matched concepts, then linked
 *   context — trimmed to a word budget.
 */

import { buildGraph, type WikiGraph } from './graph.ts';
import { conceptDocs, type Vault, type WikiDoc } from './vault.ts';

// ── Query tokenisation ───────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for',
  'from', 'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'that',
  'the', 'this', 'to', 'us', 'was', 'we', 'what', 'when', 'where', 'which', 'why',
  'with', 'you',
]);

export function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_-]+/)
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

// ── Lexical scoring (shared by wiki_search and dive seeds) ───────────────────

export interface ScoredDoc {
  doc: WikiDoc;
  score: number;
  /** Which query tokens hit, and where — the explanation for the ranking. */
  matched: string[];
  snippet: string;
}

function fieldTokens(doc: WikiDoc): {
  title: Set<string>;
  tags: Set<string>;
  description: Set<string>;
  headings: Set<string>;
  path: Set<string>;
} {
  return {
    title: new Set(tokenize(doc.title)),
    tags: new Set((doc.fm?.tags ?? []).flatMap(tokenize)),
    description: new Set(tokenize(doc.fm?.description ?? '')),
    headings: new Set(doc.parsed.headings.flatMap((h) => tokenize(h.text))),
    path: new Set(tokenize(doc.bundlePath.replace(/\.md$/, ''))),
  };
}

function findSnippet(doc: WikiDoc, tokens: string[]): string {
  const lines = doc.parsed.raw.split('\n');
  for (let i = doc.parsed.bodyStartLine - 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#') || line.startsWith('<!--')) continue;
    const lower = line.toLowerCase();
    if (tokens.some((t) => lower.includes(t))) {
      return line.length > 180 ? `${line.slice(0, 177)}...` : line;
    }
  }
  return doc.fm?.description ?? '';
}

export function scoreDocs(vault: Vault, query: string): ScoredDoc[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const results: ScoredDoc[] = [];

  for (const doc of conceptDocs(vault)) {
    const fields = fieldTokens(doc);
    const bodyLower = doc.parsed.raw.toLowerCase();
    let score = 0;
    const matched = new Set<string>();

    for (const token of tokens) {
      let hit = false;
      if (fields.title.has(token)) { score += 5; hit = true; }
      if (fields.tags.has(token)) { score += 4; hit = true; }
      if (fields.description.has(token)) { score += 3; hit = true; }
      if (fields.headings.has(token)) { score += 2; hit = true; }
      if (fields.path.has(token)) { score += 2; hit = true; }
      if (doc.fm?.type === token) { score += 3; hit = true; }
      if (!hit) {
        // Body-only hits count, weakly, capped so length can't dominate.
        let count = 0;
        let idx = bodyLower.indexOf(token);
        while (idx !== -1 && count < 5) {
          count++;
          idx = bodyLower.indexOf(token, idx + token.length);
        }
        if (count > 0) { score += count * 0.5; hit = true; }
      }
      if (hit) matched.add(token);
    }

    // Multi-token queries reward docs matching MORE distinct tokens.
    if (matched.size > 1) score *= 1 + 0.25 * (matched.size - 1);

    if (score > 0) {
      results.push({
        doc,
        score: Math.round(score * 100) / 100,
        matched: [...matched],
        snippet: findSnippet(doc, tokens),
      });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Repo dive ────────────────────────────────────────────────────────────────

export interface DiveStop {
  order: number;
  path: string;
  title: string;
  wordCount: number;
  /** Why this document is on the path. */
  reason: string;
  /** 'orient' (indexes) | 'core' (matched) | 'context' (graph-linked). */
  role: 'orient' | 'core' | 'context';
}

export interface DivePlan {
  task: string;
  stops: DiveStop[];
  totalWords: number;
  budgetWords: number;
  /** Documents that scored but did not fit the budget. */
  overflow: Array<{ path: string; title: string }>;
}

/**
 * Assemble an ordered reading plan for a task. Deterministic and
 * model-free; the caller (an agent on a knowledge task) does the reading.
 */
export function repoDive(
  vault: Vault,
  task: string,
  budgetWords = 6000,
  graph: WikiGraph = buildGraph(vault),
): DivePlan {
  const scored = scoreDocs(vault, task);
  const seeds = scored.slice(0, 5);

  // Propagate seed scores along resolved links, decaying by distance.
  const propagated = new Map<string, { score: number; via: string; dist: number }>();
  for (const seed of seeds) {
    let frontier = [seed.doc.bundlePath];
    const seen = new Set(frontier);
    for (let dist = 1; dist <= 2; dist++) {
      const next: string[] = [];
      for (const path of frontier) {
        const edges = [
          ...(graph.outbound.get(path) ?? []),
          ...(graph.inbound.get(path) ?? []).map((e) => ({ ...e, target: e.source })),
        ];
        for (const edge of edges) {
          if (!edge.resolved || seen.has(edge.target)) continue;
          seen.add(edge.target);
          const gain = seed.score * Math.pow(0.4, dist);
          const prev = propagated.get(edge.target);
          if (!prev || prev.score < gain) {
            propagated.set(edge.target, { score: gain, via: seed.doc.bundlePath, dist });
          }
          next.push(edge.target);
        }
      }
      frontier = next;
    }
  }

  const stops: DiveStop[] = [];
  const included = new Set<string>();
  let totalWords = 0;
  const overflow: DivePlan['overflow'] = [];

  const push = (
    doc: WikiDoc,
    role: DiveStop['role'],
    reason: string,
  ): boolean => {
    if (included.has(doc.bundlePath)) return true;
    if (totalWords + doc.wordCount > budgetWords && stops.length > 0) {
      overflow.push({ path: doc.bundlePath, title: doc.title });
      return false;
    }
    included.add(doc.bundlePath);
    totalWords += doc.wordCount;
    stops.push({
      order: stops.length + 1,
      path: doc.bundlePath,
      title: doc.title,
      wordCount: doc.wordCount,
      reason,
      role,
    });
    return true;
  };

  // 1. Orient: the root index, then the indexes of directories holding seeds.
  const rootIndex = vault.docs.get('/index.md');
  if (rootIndex) push(rootIndex, 'orient', 'bundle map — start here');
  const seedDirs = new Set(
    seeds.map((s) => s.doc.bundlePath.replace(/\/[^/]+$/, '/index.md')),
  );
  for (const dirIndex of seedDirs) {
    const doc = vault.docs.get(dirIndex);
    if (doc && dirIndex !== '/index.md') {
      push(doc, 'orient', 'directory of matched concepts');
    }
  }

  // 2. Core: the matched concepts, best first.
  for (const seed of seeds) {
    push(seed.doc, 'core', `matched: ${seed.matched.join(', ')}`);
  }

  // 3. Context: what the core is wired to, best propagated score first.
  const contextRanked = [...propagated.entries()]
    .filter(([path]) => !included.has(path))
    .sort((a, b) => b[1].score - a[1].score);
  for (const [path, info] of contextRanked) {
    const doc = vault.docs.get(path);
    if (!doc || doc.kind === 'log') continue;
    push(
      doc,
      'context',
      `linked ${info.dist} hop(s) from ${info.via}`,
    );
  }

  return { task, stops, totalWords, budgetWords, overflow };
}
