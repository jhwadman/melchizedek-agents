/**
 * lib/wiki/format.ts — the Open Knowledge Format (OKF) v0.2 profile.
 *
 * WHY this file exists:
 *   The wiki is a directory of markdown "concept" documents with YAML
 *   frontmatter, per the OKF v0.2 spec
 *   (github.com/GoogleCloudPlatform/knowledge-catalog, okf/SPEC.md). The spec
 *   is deliberately minimal — `type` is the only required key — so every
 *   producer needs a PROFILE: which reserved fields it writes, which concept
 *   types it recognises, and how actors are named. This file is that profile,
 *   expressed as zod schemas so the same object validates frontmatter at
 *   parse time and documents the format in one place.
 *
 *   Spec facts this module encodes (OKF v0.2):
 *     - `type` is the only always-required frontmatter key (§4.1).
 *     - `index.md` and `log.md` are RESERVED filenames, not concepts (§3.1);
 *       reserved files are exempt from the `type` requirement (§11).
 *     - Links are normal markdown links; bundle-absolute (`/dir/doc.md`)
 *       is the recommended form (§6.1). Consumers MUST tolerate broken
 *       links — but a producer should still lint them (lib/wiki/lint.ts).
 *     - Trust/provenance family (§5): `generated {by, at}`, `verified`
 *       (mapping or list), `sources[]`, `status: draft|stable|deprecated`
 *       (absent = stable), `stale_after: YYYY-MM-DD`.
 *     - Actor convention (§7): `<producer>/<version>` for agents,
 *       `human:<id>` for persons, `process:<id>` for automated processes.
 *       Trust tiers (§5.3) key off the `human:` prefix.
 *     - `okf_version` may appear in the bundle-root index.md only (§12).
 */

import { z } from 'zod';

// ── Spec constants ───────────────────────────────────────────────────────────

/** OKF spec version this profile targets. Written to the root index.md. */
export const OKF_VERSION = '0.2';

/** Reserved filenames (§3.1) — never concept documents. */
export const RESERVED_FILENAMES = ['index.md', 'log.md'] as const;

export function isReservedFilename(fileName: string): boolean {
  return (RESERVED_FILENAMES as readonly string[]).includes(fileName);
}

/**
 * The subtree that never leaves this repo. Path-based visibility: a doc is
 * private iff its bundle path starts with this prefix. The export pipeline
 * copies the bundle WITHOUT this subtree, and lint's closure rule forbids
 * docs outside it from linking into it — so the published bundle is
 * link-closed by construction (see wiki/decisions/0003.)
 */
export const PRIVATE_PREFIX = '/private/';

export function isPrivatePath(bundlePath: string): boolean {
  return bundlePath.startsWith(PRIVATE_PREFIX);
}

// ── Concept types (profile vocabulary) ───────────────────────────────────────

/**
 * Recommended `type` values for this bundle. OKF requires consumers to
 * tolerate unknown types (§11), so this list steers authors without
 * rejecting anything — lint reports an unknown type as INFO, not an error.
 */
export const CONCEPT_TYPES = [
  'overview', // orientation docs: what a thing is, why it exists
  'subsystem', // a named part of the codebase and its responsibilities
  'syndicate', // one agent-team YAML, documented
  'tool', // a tool contract or tool family
  'model-provider', // an LLM provider adapter and its dialect quirks
  'schema', // a database or wire schema, canonically stated
  'protocol', // an interop surface: MCP, A2A
  'runbook', // step-by-step operational procedure
  'guide', // task-oriented how-to
  'decision', // one architecture decision record (ADR)
  'doctrine', // standing rules that constrain future work
  'reference', // pointer collection to external resources
  'meta', // docs about the wiki itself
] as const;

export type ConceptType = (typeof CONCEPT_TYPES)[number];

// ── Actor convention (§7) ────────────────────────────────────────────────────

/** `human:<id>` | `process:<id>` | `<producer>/<version>` */
export const actorSchema = z
  .string()
  .min(1)
  .refine(
    (a) =>
      a.startsWith('human:') ? a.length > 'human:'.length
      : a.startsWith('process:') ? a.length > 'process:'.length
      : a.includes('/'),
    {
      message:
        'actor must be "human:<id>", "process:<id>", or "<producer>/<version>"',
    },
  );

/** Actor id for structural (non-LLM) generation by this module. */
export const BUILD_ACTOR = 'process:wiki-build';

/** Actor id for LLM gap-fill: the producer is the framework, version the model. */
export function llmActor(modelId: string): string {
  return `melchizedek/${modelId}`;
}

/** Trust tiers derived from `verified` (§5.3). */
export type TrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed';

// ── Frontmatter schemas ──────────────────────────────────────────────────────

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const generatedSchema = z.looseObject({
  by: actorSchema,
  /** Last meaningful content change (ISO 8601). */
  at: z.string().optional(),
});

export const verifiedEntrySchema = z.looseObject({
  by: actorSchema,
  at: z.string().optional(),
});

export const sourceSchema = z.looseObject({
  /** Stable key for citing this source from the body. */
  id: z.string().optional(),
  /** URL or bundle path of the material this concept derives from. */
  resource: z.string().min(1),
  title: z.string().optional(),
  author: z.string().optional(),
  last_modified: isoDateSchema.optional(),
});

/**
 * Concept frontmatter. `.loose*` throughout: OKF conformance forbids
 * rejecting unknown keys (§11), so extra fields pass through untouched.
 */
export const conceptFrontmatterSchema = z.looseObject({
  /** The ONLY required key (§4.1). */
  type: z.string().min(1, 'OKF requires a non-empty `type`'),
  title: z.string().optional(),
  description: z.string().optional(),
  /** URL of the live resource this concept describes. */
  resource: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** Absent status means `stable` (§5.4). */
  status: z.enum(['draft', 'stable', 'deprecated']).optional(),
  stale_after: isoDateSchema.optional(),
  generated: generatedSchema.optional(),
  /** Bare mapping MUST be treated as a one-element list (§5.2). */
  verified: z
    .union([verifiedEntrySchema, z.array(verifiedEntrySchema)])
    .optional(),
  sources: z.array(sourceSchema).optional(),
});

export type ConceptFrontmatter = z.infer<typeof conceptFrontmatterSchema>;

/** Root index.md frontmatter — the only place `okf_version` may live (§12). */
export const rootIndexFrontmatterSchema = z.looseObject({
  okf_version: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  generated: generatedSchema.optional(),
});

// ── Derivations ──────────────────────────────────────────────────────────────

/** Normalise `verified` to a list (§5.2) — bare mapping = one-element list. */
export function verifiedEntries(
  fm: ConceptFrontmatter,
): Array<z.infer<typeof verifiedEntrySchema>> {
  if (!fm.verified) return [];
  return Array.isArray(fm.verified) ? fm.verified : [fm.verified];
}

/** Trust tier per §5.3: any `human:` verifier ⇒ human-reviewed. */
export function trustTier(fm: ConceptFrontmatter): TrustTier {
  const entries = verifiedEntries(fm);
  if (entries.length === 0) return 'unverified';
  return entries.some((v) => v.by.startsWith('human:'))
    ? 'human-reviewed'
    : 'machine-confirmed';
}

/** Effective lifecycle status — absent means stable (§5.4). */
export function effectiveStatus(
  fm: ConceptFrontmatter,
): 'draft' | 'stable' | 'deprecated' {
  return fm.status ?? 'stable';
}

/** Stale when today >= stale_after (§5.5). `today` is YYYY-MM-DD. */
export function isStale(fm: ConceptFrontmatter, today: string): boolean {
  return fm.stale_after !== undefined && today >= fm.stale_after;
}

// ── Log format (reserved log.md, §9) ─────────────────────────────────────────

/** Operations recorded in log.md, one `## [date] op | summary` entry each. */
export const LOG_OPS = [
  'init',
  'build',
  'fill',
  'garden',
  'ingest',
  'lint',
  /** One asserted relation added to the entity graph (lib/wiki/entities.ts). */
  'relate',
] as const;
export type LogOp = (typeof LOG_OPS)[number];

export const LOG_ENTRY_RE = /^## \[(\d{4}-\d{2}-\d{2})\] ([a-z]+) \| (.+)$/;

export function formatLogEntry(
  date: string,
  op: LogOp,
  summary: string,
  detail?: string,
): string {
  const head = `## [${date}] ${op} | ${summary}`;
  return detail ? `${head}\n\n${detail.trim()}\n` : `${head}\n`;
}
