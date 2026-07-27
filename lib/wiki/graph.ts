/**
 * lib/wiki/graph.ts — the knowledge graph derived from links.
 *
 * WHY this file exists:
 *   OKF's insight is that a directory of markdown files with links IS a
 *   graph — no database required. This module makes that graph explicit:
 *   nodes are documents, edges are resolved markdown links between them.
 *   Everything downstream that "navigates" (neighbors, repo-dive reading
 *   paths, orphan detection in lint, the exported graph.json) traverses the
 *   structure built here.
 *
 *   The graph is always DERIVED, never stored: rebuild-from-files is cheap
 *   at this scale and can't drift from the documents the way a cached
 *   index could. `wiki:build --graph` merely snapshots this derivation for
 *   visualisation.
 */

import { effectiveStatus, trustTier, type TrustTier } from './format.ts';
import {
  lookupTarget,
  resolveLinkTarget,
  type Vault,
  type WikiDoc,
} from './vault.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  path: string;
  title: string;
  /** OKF concept type; index/log files carry their reserved kind instead. */
  type: string;
  kind: WikiDoc['kind'];
  status: 'draft' | 'stable' | 'deprecated';
  trust: TrustTier;
  isPrivate: boolean;
  wordCount: number;
  tags: string[];
}

export interface GraphEdge {
  /** Bundle path of the linking document. */
  source: string;
  /** Normalised bundle path of the target (which may not exist). */
  target: string;
  /** False when the target is not a document in the bundle. */
  resolved: boolean;
  /** Anchor text of the link. */
  text: string;
  line: number;
}

export interface WikiGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  outbound: Map<string, GraphEdge[]>;
  inbound: Map<string, GraphEdge[]>;
}

// ── Construction ─────────────────────────────────────────────────────────────

export function buildGraph(vault: Vault): WikiGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const outbound = new Map<string, GraphEdge[]>();
  const inbound = new Map<string, GraphEdge[]>();

  for (const doc of vault.docs.values()) {
    nodes.set(doc.bundlePath, {
      path: doc.bundlePath,
      title: doc.title,
      type:
        doc.kind === 'concept'
          ? ((doc.parsed.frontmatter?.type as string | undefined) ?? 'unknown')
          : doc.kind,
      kind: doc.kind,
      status: doc.fm ? effectiveStatus(doc.fm) : 'stable',
      trust: doc.fm ? trustTier(doc.fm) : 'unverified',
      isPrivate: doc.isPrivate,
      wordCount: doc.wordCount,
      tags: doc.fm?.tags ?? [],
    });
  }

  for (const doc of vault.docs.values()) {
    for (const link of doc.parsed.links) {
      if (link.isImage) continue;
      const resolved = resolveLinkTarget(doc.bundlePath, link.target);
      if (resolved.kind !== 'internal') continue;
      const targetDoc = lookupTarget(vault, resolved.bundlePath);
      const edge: GraphEdge = {
        source: doc.bundlePath,
        target: targetDoc ? targetDoc.bundlePath : resolved.bundlePath,
        resolved: targetDoc !== null,
        text: link.text,
        line: link.line,
      };
      edges.push(edge);
      const out = outbound.get(edge.source) ?? [];
      out.push(edge);
      outbound.set(edge.source, out);
      if (edge.resolved) {
        const inn = inbound.get(edge.target) ?? [];
        inn.push(edge);
        inbound.set(edge.target, inn);
      }
    }
  }

  return { nodes, edges, outbound, inbound };
}

// ── Queries ──────────────────────────────────────────────────────────────────

/**
 * Concepts nothing points to: no inbound link from any OTHER document,
 * including index listings. The bundle root index and log are exempt.
 */
export function orphanConcepts(graph: WikiGraph): GraphNode[] {
  return [...graph.nodes.values()].filter((node) => {
    if (node.kind !== 'concept') return false;
    const inn = graph.inbound.get(node.path) ?? [];
    return !inn.some((e) => e.source !== node.path);
  });
}

export function brokenEdges(graph: WikiGraph): GraphEdge[] {
  return graph.edges.filter((e) => !e.resolved);
}

export interface Neighbor {
  node: GraphNode;
  /** Link hops from the origin. */
  distance: number;
  /** How we got here: the linking document. */
  via: string;
  direction: 'out' | 'in';
}

/** Breadth-first neighborhood of a document along resolved edges. */
export function neighborhood(
  graph: WikiGraph,
  originPath: string,
  depth = 1,
  direction: 'out' | 'in' | 'both' = 'both',
): Neighbor[] {
  const seen = new Set<string>([originPath]);
  const result: Neighbor[] = [];
  let frontier = [originPath];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const path of frontier) {
      const candidates: Array<{ target: string; dir: 'out' | 'in' }> = [];
      if (direction !== 'in') {
        for (const e of graph.outbound.get(path) ?? []) {
          if (e.resolved) candidates.push({ target: e.target, dir: 'out' });
        }
      }
      if (direction !== 'out') {
        for (const e of graph.inbound.get(path) ?? []) {
          candidates.push({ target: e.source, dir: 'in' });
        }
      }
      for (const c of candidates) {
        if (seen.has(c.target)) continue;
        seen.add(c.target);
        const node = graph.nodes.get(c.target);
        if (!node) continue;
        result.push({ node, distance: d, via: path, direction: c.dir });
        next.push(c.target);
      }
    }
    frontier = next;
  }
  return result;
}

// ── Serialisation ────────────────────────────────────────────────────────────

export interface GraphStats {
  documents: number;
  concepts: number;
  edges: number;
  brokenLinks: number;
  orphans: number;
  byType: Record<string, number>;
  totalWords: number;
}

export function graphStats(graph: WikiGraph): GraphStats {
  const byType: Record<string, number> = {};
  let totalWords = 0;
  let concepts = 0;
  for (const node of graph.nodes.values()) {
    totalWords += node.wordCount;
    if (node.kind !== 'concept') continue;
    concepts++;
    byType[node.type] = (byType[node.type] ?? 0) + 1;
  }
  return {
    documents: graph.nodes.size,
    concepts,
    edges: graph.edges.length,
    brokenLinks: brokenEdges(graph).length,
    orphans: orphanConcepts(graph).length,
    byType,
    totalWords,
  };
}

/** JSON-serialisable snapshot (what `wiki:build --graph` writes). */
export function graphToJson(graph: WikiGraph): {
  stats: GraphStats;
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  return {
    stats: graphStats(graph),
    nodes: [...graph.nodes.values()],
    edges: graph.edges,
  };
}
