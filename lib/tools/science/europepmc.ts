/**
 * desk/sources/europepmc.ts — the literature channel.
 *
 * Europe PMC is the best single free API for this desk: it indexes PubMed
 * (SRC:MED), PubMed Central full text (SRC:PMC), preprints (SRC:PPR) and
 * agricola/patents, it returns DOIs and PMIDs on the same record, and it
 * carries the abstract without a second call. One endpoint answers both
 * "search the literature" and "resolve this identifier".
 *
 * The SRC: prefix is load-bearing and is chosen by CODE, never by the model:
 * a preprint that arrives through the peer-reviewed search is a preprint the
 * desk will grade as reported. `searchLiterature` filters to MED and PMC;
 * `searchPreprints` filters to PPR and marks every record `preprint`.
 */

import { getJson, qs } from './http.ts';
import {
  type Record_,
  bareDoi,
  doiUrl,
  pmidUrl,
  CEILING_BY_EPMC_SOURCE,
  lowerCeiling,
} from './types.ts';

const BASE = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search';

interface EpmcResult {
  id?: string;
  source?: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  authorString?: string;
  journalInfo?: { journal?: { title?: string }; yearOfPublication?: number };
  bookOrReportDetails?: { publisher?: string };
  pubYear?: string;
  firstPublicationDate?: string;
  abstractText?: string;
  citedByCount?: number;
  pubTypeList?: { pubType?: string[] };
  commentCorrectionList?: { commentCorrection?: Array<{ type?: string; id?: string }> };
}

interface EpmcResponse {
  hitCount?: number;
  resultList?: { result?: EpmcResult[] };
}

function toRecord(r: EpmcResult, ceiling: Record_['ceiling'], source: string): Record_ {
  // The record's OWN source decides, capped by the channel's. This is what the
  // module docstring has always claimed ("a PPR record is a preprint however it
  // was asked for") and what `resolveArticle` — which applies no SRC: filter —
  // needs in order not to hand back a preprint stamped `reported`.
  const bySource = r.source ? CEILING_BY_EPMC_SOURCE[r.source.toUpperCase()] : undefined;
  const effectiveCeiling = bySource ? lowerCeiling(ceiling, bySource) : ceiling;

  const ids: Record_['alsoIds'] = [];
  if (r.doi) ids.push({ kind: 'doi', value: bareDoi(r.doi), url: doiUrl(r.doi) });
  if (r.pmid) ids.push({ kind: 'pmid', value: r.pmid, url: pmidUrl(r.pmid) });
  if (r.pmcid) {
    ids.push({
      kind: 'pmcid',
      value: r.pmcid,
      url: `https://europepmc.org/article/PMC/${r.pmcid}`,
    });
  }

  const facts: Array<[string, string]> = [];
  const types = r.pubTypeList?.pubType ?? [];
  if (types.length) facts.push(['publication type', types.join(', ')]);
  if (typeof r.citedByCount === 'number') facts.push(['cited by', String(r.citedByCount)]);

  // Europe PMC records the retraction relation itself. It is not the only
  // signal and it is not the one the guard trusts — corrections.ts asks
  // Crossref and OpenAlex before anything ships — but a record that already
  // announces one should reach the model announcing it.
  const rel = r.commentCorrectionList?.commentCorrection ?? [];
  const withdrawn = rel.find((c) => /retraction|withdraw|expression of concern/i.test(c.type ?? ''));
  // Anchored on the publisher's LABEL form ("RETRACTED:", "[RETRACTED]",
  // "RETRACTED ARTICLE:"), not on the bare word. A legitimate review titled
  // "Retracted articles in oncology: a systematic review" is about retractions,
  // not retracted, and the looser pattern marked it as withdrawn.
  const titleFlag = /^\s*\[?\s*(RETRACTED|WITHDRAWN)(\s+ARTICLE)?\s*(\]|:)/i.test(r.title ?? '');

  return {
    id: ids[0] ?? null,
    alsoIds: ids.slice(1),
    title: (r.title ?? '').replace(/\s+/g, ' ').trim(),
    venue: r.journalInfo?.journal?.title ?? r.bookOrReportDetails?.publisher,
    year: r.journalInfo?.yearOfPublication ?? (r.pubYear ? Number(r.pubYear) : undefined),
    date: r.firstPublicationDate,
    authors: r.authorString ? r.authorString.split(', ').slice(0, 8) : undefined,
    text: r.abstractText?.replace(/<[^>]+>/g, '').trim(),
    ceiling: effectiveCeiling,
    retracted:
      withdrawn || titleFlag
        ? { kind: 'retraction', by: withdrawn?.id, source: 'europepmc' }
        : null,
    facts,
    source,
  };
}

/**
 * How a result set is ordered.
 *
 * `cited` is the right default for settled literature: the most-cited work on a
 * subject is where an appraisal starts. It is the WRONG default for preprints,
 * and measurably so — a brand-new preprint has zero citations, so sorting them
 * by citation count returns the OLDEST ones. Measured against Europe PMC on
 * 2026-09-09: `(alzheimer) AND SRC:PPR` sorted `CITED desc` returned records
 * from 2019, 2024 and 2020; sorted `recent` it returned three from the previous
 * two days. The `frontier` route exists to answer "what is new" and was
 * structurally unable to see it.
 */
export type SearchSort = 'cited' | 'recent';

const SORT_FIELD: Record<SearchSort, string> = {
  cited: 'CITED desc',
  recent: 'P_PDATE_D desc',
};

export interface SearchOpts {
  sort?: SearchSort;
  /** only work first published in or after this year */
  sinceYear?: number;
}

/** `sinceYear` as a Europe PMC date clause. The value is a validated integer
 *  from the contract schema, so it cannot carry query syntax. */
const sinceClause = (year?: number): string =>
  year && Number.isInteger(year) ? ` AND (FIRST_PDATE:[${year}-01-01 TO 3000-12-31])` : '';

async function search(
  query: string,
  pageSize: number,
  source: string,
  ceiling: Record_['ceiling'],
  opts: SearchOpts = {},
) {
  const url = `${BASE}?${qs({
    query: `${query}${sinceClause(opts.sinceYear)}`,
    format: 'json',
    resultType: 'core',
    pageSize,
    sort: SORT_FIELD[opts.sort ?? 'cited'],
  })}`;
  const res = await getJson<EpmcResponse>('europepmc', url);
  const rows = res.resultList?.result ?? [];
  return {
    hits: res.hitCount ?? rows.length,
    records: rows.map((r) => toRecord(r, ceiling, source)),
  };
}

/** peer-reviewed only: PubMed and PubMed Central, never preprints */
export function searchLiterature(query: string, limit = 10, opts: SearchOpts = {}) {
  return search(`(${query}) AND (SRC:MED OR SRC:PMC)`, limit, 'europepmc', 'reported', opts);
}

/** Preprints only, every record capped at `preprint`, NEWEST FIRST by default.
 *  Recency is the whole reason to read a preprint: anything old enough to have
 *  accumulated citations has usually been through review by now, and the
 *  peer-reviewed version is what should be cited instead. */
export function searchPreprints(query: string, limit = 10, opts: SearchOpts = {}) {
  return search(`(${query}) AND SRC:PPR`, limit, 'europepmc/preprint', 'preprint', {
    ...opts,
    // `?? 'recent'`, not `{ sort: 'recent', ...opts }`: an opts object built by
    // the contract always HAS a `sort` key, and its value is `undefined` when
    // the caller omitted it — so spreading it last overwrote the default and
    // silently restored citation ordering while the header still said "newest
    // first". Caught by the live smoke test, not by types.
    sort: opts.sort ?? 'recent',
  });
}

/** resolve one DOI, PMID or PMCID. The ceiling follows the source it came
 *  back from: a PPR record is a preprint however it was asked for. That is now
 *  enforced in `toRecord` via CEILING_BY_EPMC_SOURCE — this call applies no
 *  SRC: filter, so the channel ceiling below is only an upper bound. */
export async function resolveArticle(id: string) {
  const clean = id.trim();
  const query = /^\d+$/.test(clean)
    ? `EXT_ID:${clean}`
    : /^PMC\d+$/i.test(clean)
      ? `PMCID:${clean.toUpperCase()}`
      // A quote inside the value would close the term and change the query, so
      // it is stripped rather than passed through.
      : `DOI:"${bareDoi(clean).replace(/"/g, '')}"`;
  const { records } = await search(query, 1, 'europepmc', 'reported');
  return records[0] ?? null;
}
