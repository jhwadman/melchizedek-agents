/**
 * lib/wiki/lint.ts — producer-side health checks for the bundle.
 *
 * WHY this file exists:
 *   OKF consumers MUST tolerate broken links, missing indexes, unknown
 *   fields — the spec is forgiving on purpose. A PRODUCER that leans on
 *   that forgiveness rots: links dangle, pages orphan, indexes lag their
 *   directories. This is Karpathy's "lint" operation from the LLM-wiki
 *   pattern, run as code instead of vibes. It is also the gate every write
 *   passes through: `wiki_save` refuses drafts whose errors would degrade
 *   the bundle.
 *
 *   Severity doctrine:
 *     error   — violates OKF conformance or the profile's hard rules;
 *               blocks wiki_save and fails `wiki:build --check`.
 *     warning — the bundle works but is decaying (broken link, orphan,
 *               stale doc, index gap). Surfaced, never blocking.
 *     info    — style guidance (relative links, unknown type).
 *
 *   The private-closure rule is the publishing invariant: documents outside
 *   /private/ must never link into it, so exporting the bundle minus the
 *   private subtree can never produce a dangling reference the producer
 *   didn't choose. Extra `forbiddenPatterns` (names that must not appear in
 *   public docs) are supplied BY THE CALLER — this public module does not
 *   itself know any private vocabulary.
 */

import { posix } from 'node:path';

import {
  CONCEPT_TYPES,
  isStale,
  LOG_ENTRY_RE,
} from './format.ts';
import {
  docsInDirectory,
  lookupTarget,
  resolveLinkTarget,
  type Vault,
  type WikiDoc,
} from './vault.ts';

// ── Types ────────────────────────────────────────────────────────────────────

export type LintSeverity = 'error' | 'warning' | 'info';

export interface LintFinding {
  severity: LintSeverity;
  /** Stable rule id, e.g. 'frontmatter', 'broken-link', 'index-coverage'. */
  rule: string;
  docPath: string;
  line?: number;
  message: string;
}

export interface LintReport {
  findings: LintFinding[];
  errors: number;
  warnings: number;
  ok: boolean;
}

export interface LintOptions {
  /** YYYY-MM-DD used for staleness; defaults to the current date. */
  today?: string;
  /**
   * Patterns that must not appear in PUBLIC documents (names of private
   * systems, etc.). Checked against each public doc's full text.
   */
  forbiddenPatterns?: RegExp[];
}

function report(findings: LintFinding[]): LintReport {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  return { findings, errors, warnings, ok: errors === 0 };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Per-document rules ───────────────────────────────────────────────────────

const KNOWN_TYPES = new Set<string>(CONCEPT_TYPES);

/**
 * Rules that need only the document itself (+ the vault for link targets).
 * Used both by lintVault and by the wiki_save gate on unsaved drafts.
 */
export function lintDoc(
  vault: Vault,
  doc: WikiDoc,
  options: LintOptions = {},
): LintFinding[] {
  const findings: LintFinding[] = [];
  const today = options.today ?? todayIso();

  for (const issue of doc.fmIssues) {
    findings.push({
      severity: 'error',
      rule: 'frontmatter',
      docPath: doc.bundlePath,
      message: issue,
    });
  }

  for (const wl of doc.parsed.wikilinks) {
    findings.push({
      severity: 'error',
      rule: 'wikilink-syntax',
      docPath: doc.bundlePath,
      line: wl.line,
      message: `[[${wl.target}]] is not an OKF link — use [Title](/path/doc.md)`,
    });
  }

  for (const marker of doc.parsed.unclosedMarkers) {
    findings.push({
      severity: 'error',
      rule: 'unclosed-marker',
      docPath: doc.bundlePath,
      line: marker.line,
      message: `wiki:${marker.kind} marker never closes`,
    });
  }

  for (const link of doc.parsed.links) {
    const resolved = resolveLinkTarget(doc.bundlePath, link.target);
    if (resolved.kind === 'escapes-bundle') {
      findings.push({
        severity: 'error',
        rule: 'link-escapes-bundle',
        docPath: doc.bundlePath,
        line: link.line,
        message: `link target leaves the bundle: ${link.target}`,
      });
      continue;
    }
    if (resolved.kind !== 'internal') continue;

    if (!link.isImage && !vault.docs.has(resolved.bundlePath)) {
      if (lookupTarget(vault, resolved.bundlePath) === null) {
        findings.push({
          severity: 'warning',
          rule: 'broken-link',
          docPath: doc.bundlePath,
          line: link.line,
          message: `target does not exist in the bundle: ${link.target}`,
        });
      }
    }
    if (!doc.isPrivate && resolved.bundlePath.startsWith('/private/')) {
      findings.push({
        severity: 'error',
        rule: 'private-closure',
        docPath: doc.bundlePath,
        line: link.line,
        message: `public document links into /private/: ${link.target}`,
      });
    }
    if (!link.target.startsWith('/') && !link.isImage) {
      findings.push({
        severity: 'info',
        rule: 'relative-link',
        docPath: doc.bundlePath,
        line: link.line,
        message: `prefer bundle-absolute links: ${resolved.bundlePath}`,
      });
    }
  }

  if (doc.kind === 'concept' && doc.fm) {
    if (!KNOWN_TYPES.has(doc.fm.type)) {
      findings.push({
        severity: 'info',
        rule: 'unknown-type',
        docPath: doc.bundlePath,
        message: `type "${doc.fm.type}" is not in the profile vocabulary (allowed, but check for a near-miss)`,
      });
    }
    if (isStale(doc.fm, today)) {
      findings.push({
        severity: 'warning',
        rule: 'stale',
        docPath: doc.bundlePath,
        message: `stale since ${doc.fm.stale_after} — re-verify or update`,
      });
    }
  }

  if (doc.kind === 'log') {
    const lines = doc.parsed.raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ') && !LOG_ENTRY_RE.test(lines[i])) {
        findings.push({
          severity: 'warning',
          rule: 'log-format',
          docPath: doc.bundlePath,
          line: i + 1,
          message: 'log entry must be "## [YYYY-MM-DD] <op> | <summary>"',
        });
      }
    }
  }

  if (!doc.isPrivate && options.forbiddenPatterns) {
    for (const pattern of options.forbiddenPatterns) {
      const match = doc.parsed.raw.match(pattern);
      if (match) {
        findings.push({
          severity: 'error',
          rule: 'forbidden-term',
          docPath: doc.bundlePath,
          message: `public document mentions a private name: "${match[0]}"`,
        });
      }
    }
  }

  return findings;
}

// ── Bundle-wide rules ────────────────────────────────────────────────────────

function lintIndexCoverage(vault: Vault): LintFinding[] {
  const findings: LintFinding[] = [];

  const directories = new Set<string>(['/']);
  for (const doc of vault.docs.values()) {
    const dir = posix.dirname(doc.bundlePath);
    directories.add(dir === '/' ? '/' : `${dir}/`);
  }

  for (const dir of directories) {
    const indexPath = posix.join(dir, 'index.md');
    const index = vault.docs.get(indexPath);
    if (!index) {
      findings.push({
        severity: 'warning',
        rule: 'missing-index',
        docPath: indexPath,
        message: `directory ${dir} has no index.md (progressive disclosure gap)`,
      });
      continue;
    }
    // Every concept in the directory should be linked from its index; a
    // private annex directory may be listed from the root but never the
    // reverse (the closure rule handles direction).
    const listed = new Set<string>();
    for (const link of index.parsed.links) {
      const resolved = resolveLinkTarget(indexPath, link.target);
      if (resolved.kind === 'internal') {
        const target = lookupTarget(vault, resolved.bundlePath);
        listed.add(target ? target.bundlePath : resolved.bundlePath);
      }
    }
    for (const doc of docsInDirectory(vault, dir)) {
      if (doc.kind !== 'concept') continue;
      if (index.isPrivate === doc.isPrivate && !listed.has(doc.bundlePath)) {
        findings.push({
          severity: 'warning',
          rule: 'index-coverage',
          docPath: indexPath,
          message: `${doc.bundlePath} is not listed in its directory index`,
        });
      }
    }
  }

  // Root index should declare the spec version it targets.
  const root = vault.docs.get('/index.md');
  if (root && !root.parsed.frontmatter?.okf_version) {
    findings.push({
      severity: 'info',
      rule: 'okf-version',
      docPath: '/index.md',
      message: 'root index.md should declare okf_version in frontmatter',
    });
  }

  return findings;
}

function lintOrphans(vault: Vault): LintFinding[] {
  const inbound = new Set<string>();
  for (const doc of vault.docs.values()) {
    for (const link of doc.parsed.links) {
      const resolved = resolveLinkTarget(doc.bundlePath, link.target);
      if (resolved.kind !== 'internal') continue;
      const target = lookupTarget(vault, resolved.bundlePath);
      if (target && target.bundlePath !== doc.bundlePath) {
        inbound.add(target.bundlePath);
      }
    }
  }
  const findings: LintFinding[] = [];
  for (const doc of vault.docs.values()) {
    if (doc.kind !== 'concept') continue;
    if (!inbound.has(doc.bundlePath)) {
      findings.push({
        severity: 'warning',
        rule: 'orphan',
        docPath: doc.bundlePath,
        message: 'no document links here — connect it or reconsider it',
      });
    }
  }
  return findings;
}

// ── Entry points ─────────────────────────────────────────────────────────────

export function lintVault(vault: Vault, options: LintOptions = {}): LintReport {
  const findings: LintFinding[] = [];
  for (const doc of vault.docs.values()) {
    findings.push(...lintDoc(vault, doc, options));
  }
  findings.push(...lintIndexCoverage(vault));
  findings.push(...lintOrphans(vault));
  findings.sort((a, b) =>
    a.docPath === b.docPath
      ? (a.line ?? 0) - (b.line ?? 0)
      : a.docPath.localeCompare(b.docPath),
  );
  return report(findings);
}

export function formatLintReport(result: LintReport): string {
  if (result.findings.length === 0) return 'lint: clean — no findings.';
  const lines = result.findings.map(
    (f) =>
      `${f.severity.toUpperCase().padEnd(7)} ${f.rule.padEnd(20)} ${f.docPath}${
        f.line ? `:${f.line}` : ''
      } — ${f.message}`,
  );
  lines.push(
    `lint: ${result.errors} error(s), ${result.warnings} warning(s), ${
      result.findings.length - result.errors - result.warnings
    } info.`,
  );
  return lines.join('\n');
}
