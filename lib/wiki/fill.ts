/**
 * lib/wiki/fill.ts — the LLM pass: write the prose a structural build can't.
 *
 * WHY this file exists:
 *   A structural build produces true-but-mute documents: tables, listings,
 *   links, and empty wiki:fill slots. This pass walks the bundle for slots
 *   still holding the TODO sentinel and asks a model to write ONLY that
 *   missing prose — one slot at a time, grounded in the document itself,
 *   its graph neighbors (the only links it may use), and excerpts of the
 *   repo files named in `sources`. The model never touches structure: the
 *   slot interior is the entire blast radius, enforced by the marker
 *   splice, and lint gates the result like any other write.
 *
 *   Provenance is honest: a filled document's `generated.by` becomes
 *   `melchizedek/<model>` — the §5.3 trust derivation then reports it as
 *   machine-confirmed at best, never human-reviewed, until a person adds
 *   a `verified` entry. No key configured → the pass reports itself
 *   skipped and the skeleton keeps its TODO sentinels; nothing breaks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runWikiAgent, modelAvailable } from './agentRun.ts';
import { llmActor } from './format.ts';
import { buildGraph, type WikiGraph } from './graph.ts';
import {
  emitFrontmatter,
  parseDoc,
  setSlotContent,
  slotIsUnfilled,
  TODO_SENTINEL,
} from './markdown.ts';
import { loadDoc, writeDocFile, type Vault, type WikiDoc } from './vault.ts';

// ── Options / outcome ────────────────────────────────────────────────────────

export interface FillOptions {
  /** Model string routed via lib/models/registry.ts. */
  model: string;
  /** Cap on documents touched in one pass. */
  maxDocs?: number;
  /** YYYY-MM-DD stamped into generated.at. */
  date: string;
  log?: (message: string) => void;
}

export interface FillOutcome {
  docsTouched: number;
  slotsFilled: number;
  slotsFailed: number;
  /** Why nothing ran, when nothing ran. */
  skippedReason?: string;
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

const WRITER_INSTRUCTION = `You write missing prose for knowledge-base documents about a software system.
You receive one document, the id of one empty slot in it, a hint describing what belongs there, link candidates, and source excerpts.
Rules:
- Write ONLY the slot's prose: no preamble, no code fences around the reply, no headings unless the hint asks.
- 60–140 words unless the hint says otherwise. Plain, concrete, present tense. No marketing language, no hedging.
- Every claim must come from the provided document, excerpts, or link candidates. If the context does not support a claim, leave it out.
- Markdown links are allowed ONLY to the exact paths listed under LINK CANDIDATES. Never invent a path or URL.
- If the context is insufficient to write anything true, reply with exactly: INSUFFICIENT_CONTEXT`;

function neighborCandidates(vault: Vault, graph: WikiGraph, doc: WikiDoc): string {
  const paths = new Set<string>();
  for (const e of graph.outbound.get(doc.bundlePath) ?? []) {
    if (e.resolved) paths.add(e.target);
  }
  for (const e of graph.inbound.get(doc.bundlePath) ?? []) paths.add(e.source);
  const lines: string[] = [];
  for (const path of [...paths].slice(0, 14)) {
    const neighbor = vault.docs.get(path);
    if (!neighbor) continue;
    const desc = neighbor.fm?.description ?? '';
    lines.push(`- ${path} — ${neighbor.title}${desc ? `: ${desc}` : ''}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

function sourceExcerpts(vault: Vault, doc: WikiDoc): string {
  const repoRoot = resolve(vault.root, '..');
  const chunks: string[] = [];
  for (const source of doc.fm?.sources ?? []) {
    const resource = source.resource;
    if (/^[a-z][a-z0-9+.-]*:/i.test(resource)) continue; // URLs: not readable here
    const abs = resource.startsWith('/')
      ? resolve(vault.root, `.${resource}`)
      : resolve(repoRoot, resource);
    if (!abs.startsWith(repoRoot) || !existsSync(abs)) continue;
    try {
      const text = readFileSync(abs, 'utf-8').split('\n').slice(0, 120).join('\n');
      chunks.push(`--- ${resource} (first 120 lines) ---\n${text}`);
    } catch {
      // unreadable source: the slot simply gets less context
    }
  }
  return chunks.length > 0 ? chunks.join('\n\n') : '(none)';
}

function buildUserText(
  vault: Vault,
  graph: WikiGraph,
  doc: WikiDoc,
  slotId: string,
  hint: string,
): string {
  return [
    `DOCUMENT (${doc.bundlePath}):`,
    doc.parsed.raw,
    `\nSLOT TO FILL: "${slotId}"`,
    `HINT: ${hint}`,
    `\nLINK CANDIDATES (the only linkable paths):`,
    neighborCandidates(vault, graph, doc),
    `\nSOURCE EXCERPTS:`,
    sourceExcerpts(vault, doc),
  ].join('\n');
}

function slotHint(slot: { content: string; id: string }): string {
  const text = slot.content.trim();
  if (text.startsWith(TODO_SENTINEL)) {
    return text.slice(TODO_SENTINEL.length).replace(/_$/, '').trim();
  }
  return slot.id;
}

/** Strip a whole-reply code fence if the model added one despite the rules. */
function cleanReply(reply: string): string {
  const trimmed = reply.trim();
  const fenced = trimmed.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  return (fenced ? fenced[1] : trimmed).trim();
}

// ── The pass ─────────────────────────────────────────────────────────────────

export async function fillVault(
  vault: Vault,
  options: FillOptions,
): Promise<FillOutcome> {
  const log = options.log ?? (() => {});
  const availability = modelAvailable(options.model);
  if (!availability.ok) {
    return {
      docsTouched: 0,
      slotsFilled: 0,
      slotsFailed: 0,
      skippedReason: `fill skipped: ${availability.reason}`,
    };
  }

  const graph = buildGraph(vault);
  const candidates = [...vault.docs.values()].filter(
    (doc) => doc.kind !== 'log' && doc.parsed.slots.some(slotIsUnfilled),
  );
  const limit = options.maxDocs ?? 50;
  let docsTouched = 0;
  let slotsFilled = 0;
  let slotsFailed = 0;

  for (const doc of candidates.slice(0, limit)) {
    let raw = doc.parsed.raw;
    let docChanged = false;

    for (const slot of doc.parsed.slots.filter(slotIsUnfilled)) {
      const hint = slotHint(slot);
      log(`fill ${doc.bundlePath} · slot "${slot.id}"`);
      const result = await runWikiAgent({
        name: 'wiki_scribe',
        description: 'Writes one missing prose passage for a wiki document.',
        model: options.model,
        instruction: WRITER_INSTRUCTION,
        userText: buildUserText(vault, graph, doc, slot.id, hint),
        temperature: 0.3,
        // Reasoning models spend thought tokens from the same budget; a
        // tight cap truncates the visible prose mid-sentence.
        maxOutputTokens: 4096,
      });

      if (result.error || result.text === '' || result.text === 'INSUFFICIENT_CONTEXT') {
        slotsFailed++;
        log(
          `  ✗ ${slot.id}: ${result.error ?? (result.text || 'empty reply')}`,
        );
        continue;
      }
      const prose = cleanReply(result.text);
      const truncated = !/[.!?)`\]]$/.test(prose.trimEnd());
      if (prose.includes(TODO_SENTINEL) || prose === '' || truncated) {
        if (truncated) log(`  ✗ ${slot.id}: reply looks truncated, slot left unfilled`);
        slotsFailed += truncated || prose === '' ? 1 : 0;
        continue;
      }
      const next = setSlotContent(raw, slot.id, prose);
      if (next) {
        raw = next;
        docChanged = true;
        slotsFilled++;
      }
    }

    if (docChanged) {
      // Stamp provenance: the model made the last meaningful change.
      const parsed = parseDoc(raw);
      if (parsed.frontmatter) {
        const fm = {
          ...parsed.frontmatter,
          generated: { by: llmActor(options.model), at: options.date },
        };
        const lines = raw.split('\n');
        const body = lines.slice(parsed.bodyStartLine - 1).join('\n');
        raw = `${emitFrontmatter(fm)}\n${body.replace(/^\n+/, '')}`;
      }
      writeDocFile(vault.root, doc.bundlePath, raw);
      // Refresh the in-memory doc so later passes see current content.
      vault.docs.set(doc.bundlePath, loadDoc(vault.root, doc.absPath));
      docsTouched++;
    }
  }

  return { docsTouched, slotsFilled, slotsFailed };
}
