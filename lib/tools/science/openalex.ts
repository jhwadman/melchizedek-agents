/**
 * desk/sources/openalex.ts — the corroboration channel.
 *
 * Europe PMC answers "what was published"; OpenAlex answers "what happened to
 * it" — how often it has been cited, and by what. That is the difference
 * between `reported` and `established`: the ladder's top grade requires
 * agreement between independent studies, and agreement has to be looked for.
 *
 * `citedBy` is a COUNT, not a verdict. A highly cited paper can be highly
 * cited for being wrong, and the desk is told so in the agent instruction.
 */

import { getJson, qs, CONTACT } from './http.ts';
import { type Record_, bareDoi, doiUrl, pmidUrl } from './types.ts';

const BASE = 'https://api.openalex.org/works';
const MAILTO = CONTACT;

/** Only the fields `toRecord` and the callers below actually read. Without it
 *  OpenAlex returns the whole Work — authorships, topics, concepts,
 *  referenced_works, counts_by_year — which measured 36,616 bytes against 694
 *  for a single lookup whose result is one boolean and a count. */
const RECORD_FIELDS =
  'id,doi,ids,display_name,publication_year,publication_date,cited_by_count,is_retracted,type,authorships,primary_location';

interface Work {
  id?: string;
  doi?: string;
  ids?: { pmid?: string; doi?: string };
  display_name?: string;
  publication_year?: number;
  publication_date?: string;
  cited_by_count?: number;
  is_retracted?: boolean;
  type?: string;
  authorships?: Array<{ author?: { display_name?: string } }>;
  primary_location?: { source?: { display_name?: string } };
  referenced_works_count?: number;
}

interface Page {
  meta?: { count?: number };
  results?: Work[];
}

function toRecord(w: Work): Record_ {
  const doi = bareDoi(w.doi ?? w.ids?.doi ?? '');
  const pmid = (w.ids?.pmid ?? '').replace(/^https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\//, '').replace(/\/$/, '');
  const ids: Record_['alsoIds'] = [];
  if (doi) ids.push({ kind: 'doi', value: doi, url: doiUrl(doi) });
  if (pmid) ids.push({ kind: 'pmid', value: pmid, url: pmidUrl(pmid) });
  if (w.id) ids.push({ kind: 'openalex', value: w.id.split('/').pop()!, url: w.id });

  const facts: Array<[string, string]> = [];
  if (typeof w.cited_by_count === 'number') facts.push(['cited by', String(w.cited_by_count)]);
  if (w.type) facts.push(['type', w.type.replace(/-/g, ' ')]);

  return {
    id: ids[0] ?? null,
    alsoIds: ids.slice(1),
    title: (w.display_name ?? '').trim(),
    venue: w.primary_location?.source?.display_name,
    year: w.publication_year,
    date: w.publication_date,
    authors: w.authorships?.slice(0, 8).map((a) => a.author?.display_name ?? '').filter(Boolean),
    ceiling: 'reported',
    retracted: w.is_retracted ? { kind: 'retraction', source: 'openalex' } : null,
    facts,
    source: 'openalex',
  };
}

export interface CitedByResult {
  hits: number;
  records: Record_[];
  of: string;
  /** the work's own citation count, or null when OpenAlex has no such work.
   *  NOT 0 for an unknown DOI: "cited 0 times" and "no such work" are different
   *  facts, and `cited_by` is the tool the `established` grade rests on. */
  citedByCount: number | null;
  /** false when the DOI resolved to nothing in OpenAlex */
  found: boolean;
}

/** what cites this work — the corroboration a claim needs to reach `established` */
export async function citedBy(doi: string, limit = 10): Promise<CitedByResult> {
  const clean = bareDoi(doi);
  const head = await getJson<Page>(
    'openalex',
    `${BASE}?${qs({ filter: `doi:${clean}`, per_page: 1, select: 'id,cited_by_count', mailto: MAILTO })}`,
  );
  const work = head.results?.[0];
  if (!work?.id) return { hits: 0, records: [], of: clean, citedByCount: null, found: false };
  const id = work.id.split('/').pop()!;
  const page = await getJson<Page>(
    'openalex',
    `${BASE}?${qs({ filter: `cites:${id}`, sort: 'cited_by_count:desc', per_page: limit, select: RECORD_FIELDS, mailto: MAILTO })}`,
  );
  return {
    hits: page.meta?.count ?? 0,
    records: (page.results ?? []).map(toRecord),
    of: clean,
    citedByCount: work.cited_by_count ?? 0,
    found: true,
  };
}

/** the shape of a field: how much has been published, and the most cited of it */
export async function surveyField(query: string, limit = 10, sinceYear?: number) {
  const filters = ['type:article'];
  if (sinceYear) filters.push(`publication_year:>${sinceYear - 1}`);
  const page = await getJson<Page>(
    'openalex',
    `${BASE}?${qs({
      search: query,
      filter: filters.join(','),
      sort: 'cited_by_count:desc',
      per_page: limit,
      select: RECORD_FIELDS,
      mailto: MAILTO,
    })}`,
  );
  return { hits: page.meta?.count ?? 0, records: (page.results ?? []).map(toRecord) };
}
