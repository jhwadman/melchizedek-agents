/**
 * lib/wiki/vault.ts — load an OKF bundle from disk and resolve its links.
 *
 * WHY this file exists:
 *   Every wiki operation (lint, graph, search, dive, garden) starts from the
 *   same picture: all documents of one bundle, parsed, with frontmatter
 *   validated against the profile and every link resolved to a
 *   bundle-absolute path. This module builds that picture once, so the
 *   layers above never touch the filesystem or path arithmetic themselves.
 *
 *   Identity: a document IS its bundle-absolute path ('/memory/schema.md') —
 *   the OKF rule that "the file path is the concept's identity." All link
 *   resolution normalises to that form.
 *
 *   The bundle root is configurable (WIKI_ROOT) so the same tooling serves
 *   any OKF bundle — this repo's wiki/ is merely the default. Writes are
 *   jailed to the bundle root: a resolved path escaping it is refused, since
 *   garden instructions and MCP callers are untrusted input.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  conceptFrontmatterSchema,
  isPrivatePath,
  isReservedFilename,
  type ConceptFrontmatter,
} from './format.ts';
import { parseDoc, type ParsedDoc } from './markdown.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type DocKind = 'concept' | 'index' | 'log';

export interface WikiDoc {
  /** Bundle-absolute identity, e.g. '/memory/schema.md'. */
  bundlePath: string;
  /** Absolute filesystem path. */
  absPath: string;
  kind: DocKind;
  parsed: ParsedDoc;
  /** Profile-validated frontmatter — null for reserved files or when invalid. */
  fm: ConceptFrontmatter | null;
  /** Validation issues (consumed by lint; empty when fm parsed clean). */
  fmIssues: string[];
  title: string;
  wordCount: number;
  isPrivate: boolean;
}

export interface Vault {
  /** Absolute filesystem path of the bundle root. */
  root: string;
  /** Keyed by bundlePath. */
  docs: Map<string, WikiDoc>;
}

export type ResolvedLink =
  | { kind: 'internal'; bundlePath: string }
  | { kind: 'external' }
  | { kind: 'anchor' }
  | { kind: 'escapes-bundle' };

// ── Bundle root ──────────────────────────────────────────────────────────────

/**
 * WIKI_ROOT env var wins; default is `<repo>/wiki`, derived from this
 * module's location (lib/wiki/ → repo root) so cwd never matters.
 */
export function resolveWikiRoot(): string {
  if (process.env.WIKI_ROOT) return resolve(process.env.WIKI_ROOT);
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'wiki');
}

// ── Loading ──────────────────────────────────────────────────────────────────

function walkMarkdownFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdownFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function toBundlePath(root: string, absPath: string): string {
  const rel = absPath.slice(root.length).split(sep).join('/');
  return rel.startsWith('/') ? rel : `/${rel}`;
}

export function classifyDoc(bundlePath: string): DocKind {
  const name = posix.basename(bundlePath);
  if (name === 'index.md') return 'index';
  if (name === 'log.md') return 'log';
  return 'concept';
}

function deriveTitle(bundlePath: string, parsed: ParsedDoc): string {
  const fmTitle = parsed.frontmatter?.title;
  if (typeof fmTitle === 'string' && fmTitle.trim() !== '') return fmTitle;
  const h1 = parsed.headings.find((h) => h.depth === 1);
  if (h1) return h1.text;
  return posix.basename(bundlePath, '.md');
}

export function loadDoc(root: string, absPath: string): WikiDoc {
  const raw = readFileSync(absPath, 'utf-8');
  const bundlePath = toBundlePath(root, absPath);
  return makeWikiDoc(bundlePath, absPath, raw);
}

/** Build a WikiDoc from raw text — also used to evaluate an unsaved draft. */
export function makeWikiDoc(
  bundlePath: string,
  absPath: string,
  raw: string,
): WikiDoc {
  const kind = classifyDoc(bundlePath);
  const parsed = parseDoc(raw);

  let fm: ConceptFrontmatter | null = null;
  const fmIssues: string[] = [];
  if (parsed.frontmatterError) {
    fmIssues.push(`frontmatter YAML does not parse: ${parsed.frontmatterError}`);
  } else if (kind === 'concept') {
    if (parsed.frontmatter === null) {
      fmIssues.push('concept document has no YAML frontmatter');
    } else {
      const check = conceptFrontmatterSchema.safeParse(parsed.frontmatter);
      if (check.success) {
        fm = check.data;
      } else {
        for (const issue of check.error.issues) {
          fmIssues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
        }
      }
    }
  }

  const body = raw.split('\n').slice(parsed.bodyStartLine - 1).join('\n');
  return {
    bundlePath,
    absPath,
    kind,
    parsed,
    fm,
    fmIssues,
    title: deriveTitle(bundlePath, parsed),
    wordCount: body.split(/\s+/).filter(Boolean).length,
    isPrivate: isPrivatePath(bundlePath),
  };
}

export function loadVault(root: string = resolveWikiRoot()): Vault {
  const absRoot = resolve(root);
  if (!existsSync(absRoot)) {
    throw new Error(
      `wiki bundle root not found: ${absRoot} (set WIKI_ROOT or run wiki:init)`,
    );
  }
  const docs = new Map<string, WikiDoc>();
  for (const file of walkMarkdownFiles(absRoot).sort()) {
    const doc = loadDoc(absRoot, file);
    docs.set(doc.bundlePath, doc);
  }
  return { root: absRoot, docs };
}

// ── Link resolution ──────────────────────────────────────────────────────────

const EXTERNAL_RE = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Resolve a link target as written to bundle-absolute form. Directory links
 * ('/agents/' or '/agents') resolve to that directory's index.md — the OKF
 * progressive-disclosure convention.
 */
export function resolveLinkTarget(
  fromBundlePath: string,
  target: string,
): ResolvedLink {
  if (target.startsWith('#')) return { kind: 'anchor' };
  if (EXTERNAL_RE.test(target)) return { kind: 'external' };

  const pathPart = target.split('#')[0].split('?')[0];
  if (pathPart === '') return { kind: 'anchor' };

  const base = pathPart.startsWith('/')
    ? pathPart
    : posix.join(posix.dirname(fromBundlePath), pathPart);
  let normalized = posix.normalize(base);
  if (normalized.startsWith('..') || !normalized.startsWith('/')) {
    return { kind: 'escapes-bundle' };
  }
  if (normalized.endsWith('/')) normalized += 'index.md';
  return { kind: 'internal', bundlePath: normalized };
}

/** Existing doc for an internal target, trying `/dir` → `/dir/index.md`. */
export function lookupTarget(vault: Vault, bundlePath: string): WikiDoc | null {
  const direct = vault.docs.get(bundlePath);
  if (direct) return direct;
  if (!bundlePath.endsWith('.md')) {
    return vault.docs.get(posix.join(bundlePath, 'index.md')) ?? null;
  }
  return null;
}

// ── Writing (path-jailed) ────────────────────────────────────────────────────

/**
 * Absolute filesystem path for a bundle path, refusing anything that
 * resolves outside the bundle root. Callers pass user/agent-supplied paths.
 */
export function jailedAbsPath(root: string, bundlePath: string): string {
  const abs = resolve(root, `.${posix.normalize(`/${bundlePath}`)}`);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    throw new Error(`path escapes the wiki bundle: ${bundlePath}`);
  }
  return abs;
}

export function writeDocFile(root: string, bundlePath: string, raw: string): void {
  const abs = jailedAbsPath(root, bundlePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf-8');
}

// ── Convenience views ────────────────────────────────────────────────────────

export function conceptDocs(vault: Vault): WikiDoc[] {
  return [...vault.docs.values()].filter((d) => d.kind === 'concept');
}

export function indexDocs(vault: Vault): WikiDoc[] {
  return [...vault.docs.values()].filter((d) => d.kind === 'index');
}

export function docsInDirectory(vault: Vault, dirBundlePath: string): WikiDoc[] {
  const prefix = dirBundlePath.endsWith('/') ? dirBundlePath : `${dirBundlePath}/`;
  return [...vault.docs.values()].filter(
    (d) =>
      d.bundlePath.startsWith(prefix) &&
      !d.bundlePath.slice(prefix.length).includes('/'),
  );
}

export function isReservedDoc(doc: WikiDoc): boolean {
  return isReservedFilename(posix.basename(doc.bundlePath));
}
