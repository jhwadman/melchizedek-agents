/**
 * desk/sources/types.ts — the one record shape every source normalises into.
 *
 * The whole point of a normalised record is the `id` field: a permanent,
 * resolvable identifier. Everything downstream — the identifier-closure guard,
 * the retraction check, the citation the reader clicks — keys off it. A source
 * that cannot produce one produces an `anecdotal` record with `id: null`, and
 * the guards treat it accordingly.
 */

/** The evidence ladder, cold to warm to red. Declared here rather than in a
 *  taxonomy file because these tools are contracts consumed by any syndicate,
 *  and a contract carries its own vocabulary. */
export type GradeKey =
  | 'established'
  | 'reported'
  | 'registered'
  | 'preprint'
  | 'contested'
  | 'anecdotal'
  | 'retracted';

export type IdKind = 'nct' | 'doi' | 'pmid' | 'pmcid' | 'openalex' | 'url';

export interface Identifier {
  kind: IdKind;
  value: string;
  /** where a reader goes to see it themselves */
  url: string;
}

export interface Record_ {
  /** the canonical identifier; null only for sources that have none */
  id: Identifier | null;
  /** every other id this record carries, so closure can match any of them */
  alsoIds: Identifier[];
  title: string;
  /** The short name the SOURCE assigns this record: a registry acronym
   *  (EMERGE, SELECT, RECOVERY). Load-bearing for the name-correspondence
   *  guard, which is the only check that catches a real identifier attached to
   *  the wrong study. Absent where the source assigns none. */
  acronym?: string;
  /** journal, registry, preprint server, or the site */
  venue?: string;
  year?: number;
  date?: string;
  authors?: string[];
  /** the abstract, a registry summary, or the post's text — always verbatim */
  text?: string;
  /** the HIGHEST grade this record can support on its own. A channel ceiling
   *  and a record ceiling are different things: Europe PMC can reach
   *  `established`, but one Europe PMC record on its own reaches `reported`. */
  ceiling: GradeKey;
  /** set when the corrections channel found something. Terminal. */
  retracted?: {
    kind: 'retraction' | 'withdrawal' | 'concern' | 'correction';
    date?: string;
    by?: string;
    source: string;
  } | null;
  /** free-form, printed to the model verbatim under the record */
  facts?: Array<[label: string, value: string]>;
  source: string;
}

/** Strip any resolver prefix from a DOI. ONE definition, because the variants
 *  had already drifted: four call sites stripped `doi.org` only, so a DOI that
 *  arrives as `https://dx.doi.org/10.…` (routine in Crossref-sourced rows) kept
 *  its prefix, `doiUrl` emitted `https://doi.org/https://dx.doi.org/10.…`, and
 *  the OpenAlex `filter=doi:` lookup matched nothing. */
export const bareDoi = (doi: string): string =>
  doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');

export const doiUrl = (doi: string) => `https://doi.org/${bareDoi(doi)}`;
export const pmidUrl = (pmid: string) => `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
export const nctUrl = (nct: string) => `https://clinicaltrials.gov/study/${nct}`;

/** How permissive each grade is, highest first. Used to take the MORE
 *  RESTRICTIVE of two ceilings: a channel cap must stay a cap, so a record's
 *  own source can only ever lower it, never raise it. */
const GRADE_RANK: Record<GradeKey, number> = {
  established: 6,
  reported: 5,
  registered: 4,
  preprint: 3,
  contested: 2,
  anecdotal: 1,
  retracted: 0,
};

/** the stricter of two ceilings */
export const lowerCeiling = (a: GradeKey, b: GradeKey): GradeKey =>
  GRADE_RANK[a] <= GRADE_RANK[b] ? a : b;

/** Europe PMC's `source` code → the highest grade a record from it supports.
 *  PPR is a preprint however it was asked for: `resolveArticle` looks the
 *  ceiling up here rather than asserting the channel's, so resolving a
 *  preprint's DOI cannot license it for the peer-reviewed grade. */
export const CEILING_BY_EPMC_SOURCE: Record<string, GradeKey> = {
  PPR: 'preprint',
  MED: 'reported',
  PMC: 'reported',
  AGR: 'reported',
  CBA: 'reported',
  CTX: 'reported',
  ETH: 'reported',
  HIR: 'reported',
  NBK: 'reported',
  PAT: 'anecdotal',
};
