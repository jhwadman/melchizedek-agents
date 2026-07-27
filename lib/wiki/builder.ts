/**
 * lib/wiki/builder.ts — docs assembled from typed parts, refreshed in place.
 *
 * WHY this file exists:
 *   "Build the docs structurally" means a document's skeleton — frontmatter,
 *   generated sections, prose slots — is code output, not typing. A DocSpec
 *   declares the parts; this engine renders a new file or REFRESHES an
 *   existing one, and the refresh contract is the whole point:
 *
 *     - machine-owned regions (wiki:generated markers) are rewritten from
 *       the current spec — repo truth can never drift from the doc;
 *     - prose (everything outside markers, and filled wiki:fill slots) is
 *       preserved verbatim — a rebuild never destroys writing, human or LLM;
 *     - `generated {by, at}` is bumped only when content actually changed,
 *       so rebuilds are idempotent and diffs stay honest.
 *
 *   The engine is bundle-agnostic: what to generate FROM (agent YAMLs, tool
 *   contracts, SQL) is the caller's business (scripts/wiki_build.ts here);
 *   this module only guarantees the mechanics.
 */

import { existsSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { formatLogEntry, type LogOp } from './format.ts';
import {
  emitDoc,
  emitFrontmatter,
  fillSlot,
  generatedBlock,
  insertLogEntry,
  mdLink,
  parseDoc,
  setGeneratedContent,
  setSlotContent,
  slotIsUnfilled,
} from './markdown.ts';
import { jailedAbsPath, writeDocFile } from './vault.ts';

// ── Spec model ───────────────────────────────────────────────────────────────

export type BodyPart =
  | { kind: 'prose'; markdown: string }
  | { kind: 'generated'; id: string; source: string; markdown: string }
  | { kind: 'fill'; id: string; hint: string };

export interface DocSpec {
  bundlePath: string;
  /** Spec-owned frontmatter. Omit entirely for reserved files (indexes). */
  fm?: Record<string, unknown>;
  body: BodyPart[];
}

export interface BuildContext {
  /** Actor recorded in `generated.by` for structural output. */
  actor: string;
  /** ISO date stamped into `generated.at` when content changes. */
  date: string;
}

export type UpsertAction = 'created' | 'updated' | 'unchanged';

// ── Rendering (fresh documents) ──────────────────────────────────────────────

function renderPart(part: BodyPart): string {
  switch (part.kind) {
    case 'prose':
      return part.markdown.trim();
    case 'generated':
      return generatedBlock(part.id, part.source, part.markdown);
    case 'fill':
      return fillSlot(part.id, undefined, part.hint);
  }
}

export function renderDoc(spec: DocSpec, ctx: BuildContext): string {
  const body = spec.body.map(renderPart).join('\n\n');
  if (!spec.fm) return `${body.trim()}\n`;
  const fm = {
    ...spec.fm,
    generated: { by: ctx.actor, at: ctx.date },
  };
  return emitDoc(fm, body);
}

// ── Refreshing (existing documents) ──────────────────────────────────────────

function replaceFrontmatterBlock(
  raw: string,
  fm: Record<string, unknown>,
): string {
  const parsed = parseDoc(raw);
  const lines = raw.split('\n');
  const body = lines.slice(parsed.bodyStartLine - 1).join('\n');
  return `${emitFrontmatter(fm)}\n${body.replace(/^\n+/, '')}`;
}

/** Raw text with the volatile `generated:` stamp neutralised, for comparison. */
function comparable(raw: string): string {
  const parsed = parseDoc(raw);
  if (parsed.frontmatter === null) return raw;
  const { generated: _drop, ...rest } = parsed.frontmatter;
  return replaceFrontmatterBlock(raw, rest);
}

export function refreshDoc(
  existingRaw: string,
  spec: DocSpec,
  ctx: BuildContext,
): { raw: string; changed: boolean } {
  const existing = parseDoc(existingRaw);

  // Harvest prose already written into fill slots, keyed by slot id.
  const harvested = new Map<string, string>();
  for (const slot of existing.slots) {
    if (!slotIsUnfilled(slot)) harvested.set(slot.id, slot.content);
  }

  let raw = existingRaw;

  // Frontmatter: spec keys win; human-added keys (status, verified, tags…)
  // survive because the merge starts from what is on disk.
  if (spec.fm) {
    const merged = { ...(existing.frontmatter ?? {}), ...spec.fm };
    raw = replaceFrontmatterBlock(raw, merged);
  }

  // Machine-owned regions: rewrite interiors; append blocks the doc lacks.
  for (const part of spec.body) {
    if (part.kind === 'generated') {
      const next = setGeneratedContent(raw, part.id, part.markdown);
      raw = next ?? `${raw.trimEnd()}\n\n${generatedBlock(part.id, part.source, part.markdown)}\n`;
    }
    if (part.kind === 'fill') {
      const present = parseDoc(raw).slots.some((s) => s.id === part.id);
      if (!present) {
        raw = `${raw.trimEnd()}\n\n${fillSlot(part.id, undefined, part.hint)}\n`;
      }
    }
  }

  // Re-inject harvested prose into any slot the regeneration re-emitted.
  for (const [id, content] of harvested) {
    const current = parseDoc(raw).slots.find((s) => s.id === id);
    if (current && slotIsUnfilled(current)) {
      raw = setSlotContent(raw, id, content) ?? raw;
    }
  }

  const changed = comparable(raw) !== comparable(existingRaw);
  if (changed && spec.fm) {
    const merged = {
      ...(parseDoc(raw).frontmatter ?? {}),
      generated: { by: ctx.actor, at: ctx.date },
    };
    raw = replaceFrontmatterBlock(raw, merged);
  }
  return { raw, changed };
}

// ── Upsert ───────────────────────────────────────────────────────────────────

export function upsertDoc(
  root: string,
  spec: DocSpec,
  ctx: BuildContext,
): UpsertAction {
  const abs = jailedAbsPath(root, spec.bundlePath);
  if (!existsSync(abs)) {
    writeDocFile(root, spec.bundlePath, renderDoc(spec, ctx));
    return 'created';
  }
  const existingRaw = readFileSync(abs, 'utf-8');
  const { raw, changed } = refreshDoc(existingRaw, spec, ctx);
  if (!changed) return 'unchanged';
  writeDocFile(root, spec.bundlePath, raw);
  return 'updated';
}

// ── Index specs (progressive disclosure, §8) ─────────────────────────────────

export interface IndexEntry {
  bundlePath: string;
  title: string;
  description: string;
}

/**
 * A directory's index.md: optional hand prose survives around one generated
 * listing. Root index carries okf_version frontmatter; others none (reserved
 * files are exempt from the `type` requirement).
 */
export function indexSpec(
  dirBundlePath: string,
  heading: string,
  entries: IndexEntry[],
  subdirs: IndexEntry[] = [],
  rootFm?: Record<string, unknown>,
): DocSpec {
  const dir = dirBundlePath.endsWith('/') ? dirBundlePath : `${dirBundlePath}/`;
  const listing: string[] = [];
  for (const sub of subdirs) {
    listing.push(`- ${mdLink(sub.title, sub.bundlePath)} — ${sub.description}`);
  }
  for (const entry of entries) {
    listing.push(`- ${mdLink(entry.title, entry.bundlePath)} — ${entry.description}`);
  }
  return {
    bundlePath: posix.join(dir, 'index.md'),
    ...(rootFm ? { fm: rootFm } : {}),
    body: [
      { kind: 'prose', markdown: `# ${heading}` },
      {
        kind: 'generated',
        id: 'listing',
        source: 'directory contents',
        markdown: listing.join('\n'),
      },
    ],
  };
}

// ── Log (reserved log.md, §9) ────────────────────────────────────────────────

const LOG_PREAMBLE = `# Log

Chronological record of changes to this bundle, newest first. Entries are
machine-parseable: \`## [YYYY-MM-DD] <op> | <summary>\`.`;

export function appendLog(
  root: string,
  date: string,
  op: LogOp,
  summary: string,
  detail?: string,
): void {
  const abs = jailedAbsPath(root, '/log.md');
  const entry = formatLogEntry(date, op, summary, detail);
  const raw = existsSync(abs) ? readFileSync(abs, 'utf-8') : `${LOG_PREAMBLE}\n`;
  writeDocFile(root, '/log.md', insertLogEntry(raw, entry));
}
