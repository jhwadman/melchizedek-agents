/**
 * lib/tools/scienceTools.ts — the clinical-evidence tools, defined as tool
 * CONTRACTS (lib/tools/toolContract.ts): one zod schema per tool is the single
 * source of truth, from which both deployment surfaces derive — the ADK
 * FunctionTools consumed by lib/toolRegistry.ts, and the MCP tools/list entries
 * served by scripts/science_mcp_server.ts.
 *
 * Ported from the science desk (2026-09-08). The four source clients under
 * lib/tools/science/ are that desk's, verbatim: Europe PMC (literature and
 * preprints), ClinicalTrials.gov v2 (registry), Crossref + OpenAlex
 * (corrections), OpenAlex (citations). All free; all keyed on permanent
 * identifiers (DOI, PMID, NCT).
 *
 * TWO DISCIPLINES the contracts enforce in CODE, not in the prompt:
 *
 *   THE CHANNEL DECIDES THE CEILING. `search_literature` filters to peer-
 *   reviewed sources; `search_preprints` filters to preprint servers. A model
 *   cannot ask for "papers" and be handed a preprint it will then grade as
 *   reported, because the two are different tools with different ceilings
 *   printed on every record they return.
 *
 *   A RESULT IS A TEXT BLOCK, NOT A JSON DUMP. Every record prints with its
 *   identifier, its ceiling, its facts and its verbatim abstract, so the model
 *   reads what a person would read. JSON invites restructuring; a labelled
 *   block invites quoting — and every identifier in it is one a downstream
 *   closure check can verify against.
 */

import { z } from 'zod';
import { defineTool } from './toolContract.ts';
import type { ToolContract } from './toolContract.ts';
import { searchLiterature, searchPreprints, resolveArticle } from './science/europepmc.ts';
import { searchTrials, resolveTrial, TRIAL_STATUSES } from './science/trials.ts';
import { citedBy, surveyField } from './science/openalex.ts';
import { checkCorrections } from './science/corrections.ts';
import type { Record_ } from './science/types.ts';

/** records a source tool returns at most; a ceiling, never a target */
export const RESULTS_PER_CALL = 10;

// ---------------------------------------------------------------------------
// Printing: what the model reads
// ---------------------------------------------------------------------------

/** Exported for tests. lib/guards/science.ts parses exactly this layout to
 *  build its ledger, and the two lived in different files with nothing pinning
 *  the format across the boundary — so a test suite that hand-rolled the layout
 *  would keep passing while the guard went silent in production. Tests build
 *  their fixtures with this function for that reason. */
export function printRecord(r: Record_, n: number): string {
  const lines: string[] = [];
  const id = r.id ? `${r.id.kind.toUpperCase()} ${r.id.value}` : 'NO IDENTIFIER';
  lines.push(`[${n}] ${r.title || '(untitled)'}`);
  lines.push(`    ${id}${r.id ? ` · ${r.id.url}` : ''}`);
  // EVERY other identifier this record carries, which types.ts:36 has always
  // said is why `alsoIds` exists ("so closure can match any of them") — and
  // which nothing printed. Europe PMC puts the DOI first, so a record's PMID
  // and PMCID never reached the model or the ledger: citing by PMID, which the
  // grade ladder explicitly permits, was stamped UNVERIFIED by the guard.
  for (const also of r.alsoIds ?? []) {
    lines.push(`    ${also.kind.toUpperCase()} ${also.value} · ${also.url}`);
  }
  if (r.acronym) lines.push(`    ACRONYM: ${r.acronym}`);
  const where = [r.venue, r.year ? String(r.year) : r.date].filter(Boolean).join(', ');
  if (where) lines.push(`    ${where}`);
  if (r.authors?.length) lines.push(`    ${r.authors.slice(0, 6).join(', ')}${r.authors.length > 6 ? ', et al.' : ''}`);
  lines.push(`    CEILING: ${r.ceiling} — nothing from this record may be graded above it`);
  if (r.retracted) {
    lines.push(`    *** ${r.retracted.kind.toUpperCase()} recorded by ${r.retracted.source}. This work cannot support a claim at any grade. ***`);
  }
  for (const [k, v] of r.facts ?? []) lines.push(`    ${k}: ${v}`);
  if (r.text) lines.push(`    ---\n    ${r.text.slice(0, 1600).replace(/\n+/g, '\n    ')}`);
  return lines.join('\n');
}

function block(head: string, records: Record_[], tail?: string): string {
  const body = records.length
    ? records.map((r, i) => printRecord(r, i + 1)).join('\n\n')
    : 'NOTHING RETURNED. This is one query against one source. It is not evidence that nothing exists — say so in exactly those terms, or rephrase and ask again.';
  return [head, '', body, tail ? `\n${tail}` : ''].join('\n');
}

const limit = z.number().int().min(1).max(RESULTS_PER_CALL).optional()
  .describe(`how many records, 1 to ${RESULTS_PER_CALL}`);

/**
 * A contract returns an error STRING and never throws.
 *
 * That is the convention lib/tools/toolContract.ts states in writing and every
 * hand-written tool in the other tool families follows; the science half followed
 * neither. A `SourceError` escaping `execute` propagated through the ADK runner
 * and aborted the agent's whole turn, where the same failure returned as text
 * lets the model read what broke and reach for a different channel — and, just
 * as importantly, keeps the turn alive so the guards still run over what DID
 * come back.
 *
 * The wording matters too: a source that could not be reached is a failure to
 * ASK, and the desk's whole discipline is that this is not the same as an
 * absence of evidence.
 */
async function answering(what: string, run: () => Promise<string>): Promise<string> {
  try {
    return await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `${what} — SOURCE ERROR: ${msg}. The source could not be reached. This is a failure to ASK, not an answer, and it is NOT evidence that nothing exists: say the channel was unavailable, or try another one.`;
  }
}

// ---------------------------------------------------------------------------
// The contracts
// ---------------------------------------------------------------------------

export const searchLiteratureContract = defineTool({
  name: 'search_literature',
  description:
    "Search PEER-REVIEWED literature (PubMed and PubMed Central) through Europe PMC. Returns papers with DOI, PMID, journal, year, authors and abstract. Preprints are excluded by construction — use search_preprints for those. Query syntax is Europe PMC's: bare terms are AND-ed, quotes make a phrase, OR groups alternatives.",
  schema: z.object({
    query: z.string().min(1).describe('the search, in the vocabulary the papers themselves use'),
    sort_by: z.enum(['cited', 'recent']).optional()
      .describe('`cited` (default) for the most-cited work on the subject; `recent` for the newest, when the question is about what has just been published'),
    since_year: z.number().int().min(1800).max(3000).optional()
      .describe('optional: only work first published in or after this year'),
    limit,
  }),
  execute({ query, sort_by, since_year, limit: n }) {
    return answering(`PEER-REVIEWED LITERATURE · query: ${query}`, async () => {
      const { hits, records } = await searchLiterature(query, n ?? 6, {
        sort: sort_by,
        sinceYear: since_year,
      });
      return block(
        `PEER-REVIEWED LITERATURE · query: ${query}${since_year ? ` · since ${since_year}` : ''} · ${hits.toLocaleString()} matching records, ${records.length} shown, ${sort_by === 'recent' ? 'newest first' : 'most cited first'}`,
        records,
        hits > records.length
          ? `${(hits - records.length).toLocaleString()} further records match and were not read. Any statement about how much exists is about this query, not about the literature.`
          : undefined,
      );
    });
  },
});

export const searchPreprintsContract = defineTool({
  name: 'search_preprints',
  description:
    "Search PREPRINT servers (bioRxiv, medRxiv and the rest of Europe PMC's preprint index). Returns the NEWEST first, which is the point of reading preprints at all. Everything returned is unreviewed and comes back capped at the `preprint` grade.",
  schema: z.object({
    query: z.string().min(1),
    sort_by: z.enum(['recent', 'cited']).optional()
      .describe('`recent` (default) for the newest postings; `cited` only when you want the most-discussed older preprints on the subject'),
    since_year: z.number().int().min(1800).max(3000).optional()
      .describe('optional: only work first posted in or after this year'),
    limit,
  }),
  execute({ query, sort_by, since_year, limit: n }) {
    return answering(`PREPRINTS · query: ${query}`, async () => {
      const { hits, records } = await searchPreprints(query, n ?? 6, {
        sort: sort_by,
        sinceYear: since_year,
      });
      return block(
        `PREPRINTS · query: ${query}${since_year ? ` · since ${since_year}` : ''} · ${hits.toLocaleString()} matching, ${records.length} shown, ${sort_by === 'cited' ? 'most cited first' : 'newest first'}. NONE OF THESE HAVE BEEN PEER REVIEWED; every one is capped at the \`preprint\` grade and the word "preprint" appears wherever you name one.`,
        records,
      );
    });
  },
});

export const searchTrialsContract = defineTool({
  name: 'search_trials',
  description:
    'Search the ClinicalTrials.gov registry. Returns status, phase, design, enrollment, sponsor, the PRE-REGISTERED primary outcome, and whether results have been posted. Use this to find out what a study said it would measure before it knew what it found, and to find completed trials that have reported nothing.',
  schema: z.object({
    query: z.string().min(1).describe('condition, intervention, sponsor or free text'),
    // Closed enums, not free strings. ClinicalTrials.gov treats overallStatus as
    // a closed enum and answers 400 to anything else — `Recruiting` and `ACTIVE`
    // both fail — while `aggFilters` answers 200 with ZERO results to a phase it
    // does not recognise, which `block()` then presents to the model as a
    // genuine registry silence. The second is the worse failure because nothing
    // errors, and a free `z.string()` invited exactly the casings that trip it.
    status: z.enum(TRIAL_STATUSES).optional()
      .describe('optional registry status filter'),
    phase: z.enum(['1', '2', '3', '4']).optional()
      .describe('optional trial phase: 1, 2, 3 or 4'),
    sort_by: z.enum(['relevance', 'newest']).optional()
      .describe('`relevance` (default), or `newest` to order by registration date when the question is about what has recently been registered'),
    limit,
  }),
  execute({ query, status, phase, sort_by, limit: n }) {
    return answering(`TRIAL REGISTRY · query: ${query}`, async () => {
      const { hits, records, overdue } = await searchTrials(query, {
        limit: n ?? 6,
        status,
        phase,
        sort: sort_by,
      });
      const silences = records
        .filter((r) => r.resultsOverdue)
        .map((r) => `${r.id?.value}: ${r.resultsOverdue!.status}, primary completion ${r.resultsOverdue!.completed}, ${r.resultsOverdue!.months} months ago, NO RESULTS POSTED.`);
      const tail = silences.length
        ? `RESULTS OVERDUE — ${overdue} of ${records.length} records shown:\n${silences.join('\n')}\nThis is the visible shape of publication bias, and it is a fact about the record. State it when it bears on the question.`
        : undefined;
      return block(
        `TRIAL REGISTRY · query: ${query} · ${hits.toLocaleString()} matching, ${records.length} shown. A registry record says a study was BEGUN and what it said it would measure. It is never evidence of a result.`,
        records,
        tail,
      );
    });
  },
});

export const resolveIdentifierContract = defineTool({
  name: 'resolve_identifier',
  description:
    'Resolve ONE identifier to its record: an NCT number, a DOI, a PMID or a PMCID. Always call this when the question names an identifier, before anything else.',
  schema: z.object({ id: z.string().min(1).describe('NCT########, a DOI, a PMID, or PMC#######') }),
  execute({ id }) {
    return answering(`RESOLVE ${id}`, async () => {
      const rec = /^NCT\d{8}$/i.test(id.trim()) ? await resolveTrial(id) : await resolveArticle(id);
      if (!rec) {
        return `RESOLVE ${id} — NO RECORD. This identifier resolved to nothing in the registry or the literature index. It may be malformed, it may be too new to be indexed, or it may not exist. Do not write it into an answer as though it resolved.`;
      }
      return block(`RESOLVED ${id}`, [rec]);
    });
  },
});

export const citedByContract = defineTool({
  name: 'cited_by',
  description:
    'What has cited a paper, most cited first, through OpenAlex. This is how a claim reaches the `established` grade: independent studies that agree. A citation count is not agreement — read what the citing work says.',
  schema: z.object({ doi: z.string().min(1), limit }),
  execute({ doi, limit: n }) {
    return answering(`CITED BY · ${doi}`, async () => {
      const { hits, records, citedByCount, found } = await citedBy(doi, n ?? 6);
      // "OpenAlex does not index this work" and "this work has never been
      // cited" are different facts, and the not-found path used to print the
      // second for the first — in the one tool the `established` grade rests on.
      if (!found) {
        return `CITED BY · ${doi} — NOT INDEXED. OpenAlex has no work under this DOI, so its citation count is unknown. This is NOT a count of zero: do not report the work as uncited.`;
      }
      return block(
        `CITED BY · ${doi} · cited ${(citedByCount ?? hits).toLocaleString()} times, ${records.length} shown, most cited first. A citation is not agreement: a work is cited as often to be disputed as to be confirmed. Read what the citing work says before you count it as corroboration.`,
        records,
      );
    });
  },
});

export const surveyFieldContract = defineTool({
  name: 'survey_field',
  description:
    'How much has been published on a subject and the most cited of it, through OpenAlex. Use for the shape of a field before reading individual papers.',
  schema: z.object({
    query: z.string().min(1),
    since_year: z.number().int().optional().describe('optional: only work published in or after this year'),
    limit,
  }),
  execute({ query, since_year, limit: n }) {
    return answering(`FIELD SURVEY · ${query}`, async () => {
    const { hits, records } = await surveyField(query, n ?? 6, since_year);
    return block(
      `FIELD SURVEY · ${query}${since_year ? ` · since ${since_year}` : ''} · ${hits.toLocaleString()} works, ${records.length} shown, most cited first. This is a count of what was PUBLISHED. Studies that found nothing are published less often than studies that found something, so the shape of this list is not the shape of the evidence.`,
      records,
    );
    });
  },
});

export const checkRetractionContract = defineTool({
  name: 'check_retraction',
  description:
    'Ask Crossref and OpenAlex whether a DOI has been retracted, withdrawn, or had an expression of concern issued. Call it on any work you are about to lean on.',
  schema: z.object({ doi: z.string().min(1) }),
  execute({ doi }) {
    return answering(`RETRACTION CHECK · ${doi}`, async () => {
      const v = await checkCorrections(doi);
      if (!v.checked) {
        return `RETRACTION CHECK · ${doi} — NOT CHECKED. Neither Crossref nor OpenAlex answered${v.signals.length ? ` (${v.signals.join(', ')})` : ''}. This is not a clean bill: say the work was not checked.`;
      }
      if (v.retracted) {
        return `RETRACTION CHECK · ${doi} — ${(v.kind ?? 'retraction').toUpperCase()}${v.date ? ` on ${v.date}` : ''}, recorded by ${v.signals.join(' and ')}${v.notice ? `, notice ${v.notice}` : ''}. TERMINAL: this work cannot support a claim at any grade. Name the retraction wherever you mention the work.`;
      }
      // `v.sources`, not `v.signals`. Signals only ever records what FIRED, so
      // on a clean work it is empty and the old fallback printed the literal
      // "Crossref or OpenAlex" every time — reporting a one-source check in the
      // same words as a two-source one, in the tool whose whole premise is that
      // any single signal can miss.
      const partial = v.sources.length < 2;
      return `RETRACTION CHECK · ${doi} — no retraction, withdrawal or expression of concern recorded by ${v.sources.join(' or ')}${v.title ? ` for "${v.title}"` : ''}.${partial ? ` NOTE: only ${v.sources.join(' and ')} answered; the other corrections source did not, so this is a partial check.` : ''}`;
    });
  },
});

/** Every science contract, in the order an MCP client sees them. Exposure is
 *  still a deliberate act: the registry below and the MCP server list these
 *  explicitly. */
export const SCIENCE_TOOL_CONTRACTS: readonly ToolContract<any>[] = [
  searchLiteratureContract,
  searchPreprintsContract,
  searchTrialsContract,
  resolveIdentifierContract,
  citedByContract,
  surveyFieldContract,
  checkRetractionContract,
];

// No `export const …Tool = toFunctionTool(…)` line here on purpose.
// lib/toolRegistry.ts derives the ADK FunctionTools itself, straight from
// SCIENCE_TOOL_CONTRACTS — the same shape lib/tools/wikiTools.ts uses. Seven
// eagerly-built duplicates used to sit here that nothing imported, so every
// consumer of this module (the MCP server and scripts/wiki/build.ts among them,
// neither of which wants ADK tools at all) paid for seven schema conversions
// and seven FunctionTool constructions at import time.
