/**
 * lib/wiki/markdown.ts — structural markdown: one node model, two directions.
 *
 * WHY this file exists:
 *   The wiki needs to READ markdown structurally (frontmatter, headings,
 *   links, fenced code, edit markers — enough to lint, graph, and navigate)
 *   and to WRITE it structurally (docs assembled from typed parts, so links
 *   and frontmatter are correct by construction). Both directions share the
 *   shapes in this file.
 *
 *   Deliberately NOT a CommonMark AST. A full parser (remark/unified) would
 *   add a dependency tree to a repo that has none for markdown, to answer
 *   questions we don't ask — inline emphasis, HTML blocks, tables-as-trees.
 *   The wiki's questions are structural: what does this doc declare, where
 *   are its sections, what does it link to, which regions are machine-owned.
 *   ~300 lines answer all of them with zero new dependencies
 *   (wiki/decisions/0002). Frontmatter YAML goes through the same `yaml`
 *   package the syndicate loader already uses.
 *
 *   Editing is SURGICAL, never a re-serialise of the whole document: the
 *   parse keeps line positions, and edits splice exact line ranges (a fill
 *   slot's interior, a generated block's interior, a log insertion point).
 *   Prose the machine doesn't own is never reflowed.
 *
 * Marker grammar (HTML comments — invisible in rendered markdown):
 *   <!-- wiki:generated section="<id>" source="<path>" -->…<!-- /wiki:generated -->
 *     Machine-owned region; `wiki:build` rewrites its interior. `source`
 *     names the repo truth it derives from.
 *   <!-- wiki:fill slot="<id>" -->…<!-- /wiki:fill -->
 *     Prose slot. Structural builds leave its interior alone; the LLM pass
 *     (lib/wiki/fill.ts) replaces it while it still holds a TODO sentinel.
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// ── Node model ───────────────────────────────────────────────────────────────

export interface Heading {
  depth: number;
  text: string;
  slug: string;
  /** 1-based line number in the document. */
  line: number;
}

export interface LinkRef {
  text: string;
  /** Target exactly as written (before bundle resolution). */
  target: string;
  line: number;
  isImage: boolean;
}

export interface Fence {
  startLine: number;
  /** Closing-fence line; equals the last doc line when unclosed. */
  endLine: number;
  lang: string;
}

export interface FillSlot {
  id: string;
  /** Line of the opening marker. */
  startLine: number;
  /** Line of the closing marker. */
  endLine: number;
  /** Interior text between the markers (without the marker lines). */
  content: string;
}

export interface GeneratedBlock {
  id: string;
  source?: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface ParsedDoc {
  raw: string;
  /** YAML text between the `---` fences, or null when absent. */
  frontmatterRaw: string | null;
  /** Parsed YAML mapping; null when absent or unparseable. */
  frontmatter: Record<string, unknown> | null;
  /** YAML parse failure, when the block exists but will not parse. */
  frontmatterError?: string;
  /** 1-based line where the body (after any frontmatter block) begins. */
  bodyStartLine: number;
  headings: Heading[];
  links: LinkRef[];
  /** `[[wikilink]]` occurrences — not OKF; lint rejects them. */
  wikilinks: Array<{ target: string; line: number }>;
  fences: Fence[];
  slots: FillSlot[];
  generated: GeneratedBlock[];
  /** Marker lines that opened but never closed (lint surfaces these). */
  unclosedMarkers: Array<{ kind: 'fill' | 'generated'; line: number }>;
}

/** Sentinel left in an unfilled slot; the fill pass replaces it. */
export const TODO_SENTINEL = '_TODO(fill):';

export function slotIsUnfilled(slot: FillSlot): boolean {
  const text = slot.content.trim();
  return text === '' || text.startsWith(TODO_SENTINEL);
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const MARKER_OPEN_RE =
  /^<!--\s*wiki:(fill|generated)\s+([^>]*?)\s*-->\s*$/;
const MARKER_CLOSE_RE = /^<!--\s*\/wiki:(fill|generated)\s*-->\s*$/;
const ATTR_RE = /([a-zA-Z_]+)="([^"]*)"/g;
const INLINE_LINK_RE = /(!?)\[([^\]]*)\]\(<?([^()<>\s]+(?:\([^()]*\))?)>?(?:\s+"[^"]*")?\)/g;
const REF_DEF_RE = /^ {0,3}\[([^\]]+)\]:\s+(\S+)/;
const REF_USE_RE = /(!?)\[([^\]]+)\]\[([^\]]*)\]/g;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/** GitHub-style anchor slug — for addressing sections by name. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Mask `inline code` so syntax examples inside backticks never parse as links. */
function maskInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
}

export function parseDoc(raw: string): ParsedDoc {
  const lines = raw.split('\n');

  // Frontmatter block: `---` on line 1, closed by `---` or `...`.
  let frontmatterRaw: string | null = null;
  let frontmatter: Record<string, unknown> | null = null;
  let frontmatterError: string | undefined;
  let bodyStartLine = 1;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (t === '---' || t === '...') {
        frontmatterRaw = lines.slice(1, i).join('\n');
        bodyStartLine = i + 2;
        break;
      }
    }
    if (frontmatterRaw !== null) {
      try {
        const parsed: unknown = parseYaml(frontmatterRaw);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          frontmatter = parsed as Record<string, unknown>;
        } else if (parsed !== null) {
          frontmatterError = 'frontmatter is not a YAML mapping';
        }
      } catch (err) {
        frontmatterError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const headings: Heading[] = [];
  const links: LinkRef[] = [];
  const wikilinks: Array<{ target: string; line: number }> = [];
  const fences: Fence[] = [];
  const slots: FillSlot[] = [];
  const generated: GeneratedBlock[] = [];
  const unclosedMarkers: ParsedDoc['unclosedMarkers'] = [];
  const refDefs = new Map<string, string>();

  let openFence: { char: string; len: number; startLine: number; lang: string } | null = null;
  let openMarker:
    | { kind: 'fill' | 'generated'; id: string; source?: string; line: number }
    | null = null;

  interface PendingLink {
    isImage: boolean;
    text: string;
    label: string;
    line: number;
  }
  const refUses: PendingLink[] = [];

  for (let i = bodyStartLine - 1; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    // Fences first — nothing inside a fence is structure.
    const fenceMatch = line.match(FENCE_RE);
    if (fenceMatch) {
      const [, marks, lang] = fenceMatch;
      if (!openFence) {
        openFence = { char: marks[0], len: marks.length, startLine: lineNo, lang };
        continue;
      }
      if (marks[0] === openFence.char && marks.length >= openFence.len && lang === '') {
        fences.push({ startLine: openFence.startLine, endLine: lineNo, lang: openFence.lang });
        openFence = null;
        continue;
      }
    }
    if (openFence) continue;

    // Edit markers.
    const open = line.match(MARKER_OPEN_RE);
    if (open) {
      if (openMarker) unclosedMarkers.push({ kind: openMarker.kind, line: openMarker.line });
      const attrs: Record<string, string> = {};
      for (const m of open[2].matchAll(ATTR_RE)) attrs[m[1]] = m[2];
      openMarker = {
        kind: open[1] as 'fill' | 'generated',
        id: attrs[open[1] === 'fill' ? 'slot' : 'section'] ?? '',
        source: attrs.source,
        line: lineNo,
      };
      continue;
    }
    const close = line.match(MARKER_CLOSE_RE);
    if (close && openMarker && close[1] === openMarker.kind) {
      const content = lines.slice(openMarker.line, lineNo - 1).join('\n');
      if (openMarker.kind === 'fill') {
        slots.push({ id: openMarker.id, startLine: openMarker.line, endLine: lineNo, content });
      } else {
        generated.push({
          id: openMarker.id,
          source: openMarker.source,
          startLine: openMarker.line,
          endLine: lineNo,
          content,
        });
      }
      openMarker = null;
      continue;
    }

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      headings.push({
        depth: headingMatch[1].length,
        text: headingMatch[2],
        slug: slugify(headingMatch[2]),
        line: lineNo,
      });
      // Headings can hold links too — fall through.
    }

    const refDef = line.match(REF_DEF_RE);
    if (refDef) {
      refDefs.set(refDef[1].toLowerCase(), refDef[2]);
      continue;
    }

    const masked = maskInlineCode(line);
    for (const m of masked.matchAll(WIKILINK_RE)) {
      wikilinks.push({ target: m[1], line: lineNo });
    }
    for (const m of masked.matchAll(INLINE_LINK_RE)) {
      links.push({ isImage: m[1] === '!', text: m[2], target: m[3], line: lineNo });
    }
    // Reference-style uses resolve after all definitions are collected.
    const noInline = masked.replace(INLINE_LINK_RE, (s) => ' '.repeat(s.length));
    for (const m of noInline.matchAll(REF_USE_RE)) {
      refUses.push({
        isImage: m[1] === '!',
        text: m[2],
        label: (m[3] || m[2]).toLowerCase(),
        line: lineNo,
      });
    }
  }

  if (openFence) {
    fences.push({ startLine: openFence.startLine, endLine: lines.length, lang: openFence.lang });
  }
  if (openMarker) unclosedMarkers.push({ kind: openMarker.kind, line: openMarker.line });
  for (const use of refUses) {
    const target = refDefs.get(use.label);
    if (target) {
      links.push({ isImage: use.isImage, text: use.text, target, line: use.line });
    }
  }

  return {
    raw,
    frontmatterRaw,
    frontmatter,
    ...(frontmatterError !== undefined ? { frontmatterError } : {}),
    bodyStartLine,
    headings,
    links,
    wikilinks,
    fences,
    slots,
    generated,
    unclosedMarkers,
  };
}

// ── Sections ─────────────────────────────────────────────────────────────────

export interface SectionSlice {
  heading: Heading;
  /** 1-based inclusive line range, heading line included. */
  startLine: number;
  endLine: number;
  text: string;
}

/** The section under the heading whose slug or text matches (case-insensitive). */
export function sectionSlice(doc: ParsedDoc, nameOrSlug: string): SectionSlice | null {
  const want = nameOrSlug.toLowerCase();
  const idx = doc.headings.findIndex(
    (h) => h.slug === slugify(nameOrSlug) || h.text.toLowerCase() === want,
  );
  if (idx === -1) return null;
  const heading = doc.headings[idx];
  const next = doc.headings.slice(idx + 1).find((h) => h.depth <= heading.depth);
  const lines = doc.raw.split('\n');
  const endLine = next ? next.line - 1 : lines.length;
  return {
    heading,
    startLine: heading.line,
    endLine,
    text: lines.slice(heading.line - 1, endLine).join('\n'),
  };
}

// ── Building (docs correct by construction) ──────────────────────────────────

/** Frontmatter key order — spec-reserved fields first, extras after. */
const FM_KEY_ORDER = [
  'okf_version',
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'status',
  'stale_after',
  'generated',
  'verified',
  'sources',
];

export function emitFrontmatter(fm: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of FM_KEY_ORDER) {
    if (fm[key] !== undefined) ordered[key] = fm[key];
  }
  for (const key of Object.keys(fm)) {
    if (!(key in ordered) && fm[key] !== undefined) ordered[key] = fm[key];
  }
  // lineWidth 0: never fold long descriptions into YAML continuation lines.
  return `---\n${stringifyYaml(ordered, { lineWidth: 0 }).trimEnd()}\n---\n`;
}

export function emitDoc(fm: Record<string, unknown>, body: string): string {
  return `${emitFrontmatter(fm)}\n${body.trim()}\n`;
}

export function heading(depth: number, text: string): string {
  return `${'#'.repeat(Math.min(6, Math.max(1, depth)))} ${text}`;
}

export function mdLink(text: string, target: string): string {
  return `[${text}](${target})`;
}

function escapeCell(cell: string): string {
  return cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function table(headers: string[], rows: string[][]): string {
  const head = `| ${headers.map(escapeCell).join(' | ')} |`;
  const rule = `|${headers.map(() => '---').join('|')}|`;
  const body = rows.map((r) => `| ${r.map(escapeCell).join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

export function bulletList(items: string[]): string {
  return items.map((i) => `- ${i}`).join('\n');
}

export function fillSlot(id: string, content?: string, hint?: string): string {
  const interior =
    content && content.trim() !== ''
      ? content.trim()
      : `${TODO_SENTINEL} ${hint ?? id}_`;
  return `<!-- wiki:fill slot="${id}" -->\n${interior}\n<!-- /wiki:fill -->`;
}

export function generatedBlock(id: string, source: string, content: string): string {
  return `<!-- wiki:generated section="${id}" source="${source}" -->\n${content.trim()}\n<!-- /wiki:generated -->`;
}

// ── Surgical edits ───────────────────────────────────────────────────────────

/** Splice `content` between a slot's markers. Null when the slot is absent. */
export function setSlotContent(raw: string, slotId: string, content: string): string | null {
  const doc = parseDoc(raw);
  const slot = doc.slots.find((s) => s.id === slotId);
  if (!slot) return null;
  const lines = raw.split('\n');
  return [
    ...lines.slice(0, slot.startLine),
    content.trim(),
    ...lines.slice(slot.endLine - 1),
  ].join('\n');
}

/** Splice `content` between a generated block's markers. Null when absent. */
export function setGeneratedContent(raw: string, blockId: string, content: string): string | null {
  const doc = parseDoc(raw);
  const block = doc.generated.find((b) => b.id === blockId);
  if (!block) return null;
  const lines = raw.split('\n');
  return [
    ...lines.slice(0, block.startLine),
    content.trim(),
    ...lines.slice(block.endLine - 1),
  ].join('\n');
}

/**
 * Insert a log entry newest-first: after the preamble (everything before the
 * first `## [` entry), before existing entries. log.md stays chronologically
 * scannable from the top — the profile's reading order for recency.
 */
export function insertLogEntry(raw: string, entry: string): string {
  const lines = raw.split('\n');
  let insertAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) {
      insertAt = i;
      break;
    }
  }
  const before = lines.slice(0, insertAt).join('\n').trimEnd();
  const after = lines.slice(insertAt).join('\n').trim();
  return `${before}\n\n${entry.trim()}\n${after ? `\n${after}` : ''}`;
}
