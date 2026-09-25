/**
 * desk/sources/trials.ts — the trial registry channel (ClinicalTrials.gov v2).
 *
 * A registry record answers a question the literature cannot: what a study
 * SAID IT WOULD MEASURE, before it knew what it found. That is why this
 * channel exists, and why its ceiling is `registered` rather than a finding
 * grade — a record is evidence that a study was begun, never evidence of a
 * result.
 *
 * THE SILENCE IS COMPUTED HERE, not judged by a model. A record whose status
 * is COMPLETED or TERMINATED, whose primary completion date is more than
 * `guards.results_overdue_months` old, and which carries no posted results, is
 * flagged `resultsOverdue` with the number of months. Publication bias is
 * invisible in the literature by construction; this is the one place the desk
 * can see its shape, so it counts it rather than describing it.
 */

import { getJson, qs, SourceError } from './http.ts';
import { type Record_, nctUrl } from './types.ts';

/** A registry record complete for longer than this with no posted results is
 *  reported as a silence in its own right. Env-tunable; 12 months by default.
 *
 *  Validated rather than coerced: `Number('')` is 0, which flagged EVERY
 *  completed trial as overdue, and `Number('12mo')` is NaN, which made
 *  `months >= NaN` false for every record and switched the whole
 *  publication-bias detector off with no error and no log line. */
const RESULTS_OVERDUE_MONTHS = ((): number => {
  const raw = process.env.SCIENCE_RESULTS_OVERDUE_MONTHS;
  if (raw === undefined || raw.trim() === '') return 12;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[science] SCIENCE_RESULTS_OVERDUE_MONTHS="${raw}" is not a non-negative number — using 12.`,
    );
    return 12;
  }
  return n;
})();

const BASE = 'https://clinicaltrials.gov/api/v2/studies';

const FIELDS = [
  'protocolSection.identificationModule',
  'protocolSection.statusModule',
  'protocolSection.designModule',
  'protocolSection.conditionsModule',
  'protocolSection.armsInterventionsModule',
  'protocolSection.outcomesModule',
  'protocolSection.sponsorCollaboratorsModule',
  'protocolSection.descriptionModule',
  'hasResults',
].join(',');

interface Study {
  hasResults?: boolean;
  protocolSection?: {
    identificationModule?: { nctId?: string; briefTitle?: string; officialTitle?: string; acronym?: string };
    statusModule?: {
      overallStatus?: string;
      whyStopped?: string;
      startDateStruct?: { date?: string };
      primaryCompletionDateStruct?: { date?: string };
      completionDateStruct?: { date?: string };
      resultsFirstPostDateStruct?: { date?: string };
    };
    designModule?: {
      studyType?: string;
      phases?: string[];
      enrollmentInfo?: { count?: number; type?: string };
      designInfo?: { allocation?: string; maskingInfo?: { masking?: string }; primaryPurpose?: string };
    };
    conditionsModule?: { conditions?: string[] };
    armsInterventionsModule?: { interventions?: Array<{ type?: string; name?: string }> };
    outcomesModule?: { primaryOutcomes?: Array<{ measure?: string; timeFrame?: string }> };
    sponsorCollaboratorsModule?: { leadSponsor?: { name?: string } };
    descriptionModule?: { briefSummary?: string };
  };
}

interface StudiesResponse {
  totalCount?: number;
  studies?: Study[];
}

function monthsSince(iso?: string): number | null {
  if (!iso) return null;
  const d = new Date(iso.length === 7 ? `${iso}-01` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44));
}

export interface TrialRecord extends Record_ {
  /** COMPLETED or TERMINATED, overdue, and nothing posted */
  resultsOverdue: { months: number; status: string; completed: string } | null;
}

function toRecord(s: Study): TrialRecord {
  const p = s.protocolSection ?? {};
  const nct = p.identificationModule?.nctId ?? '';
  const status = p.statusModule?.overallStatus ?? 'UNKNOWN';
  const primaryDone = p.statusModule?.primaryCompletionDateStruct?.date;
  const months = monthsSince(primaryDone);
  const overdueAfter = RESULTS_OVERDUE_MONTHS;

  const acronym = p.identificationModule?.acronym?.trim();

  const facts: Array<[string, string]> = [];
  if (acronym) facts.push(['acronym', acronym]);
  facts.push(['status', status.toLowerCase().replace(/_/g, ' ')]);
  const phases = p.designModule?.phases;
  if (phases?.length) facts.push(['phase', phases.join('/').replace(/PHASE/g, 'phase ').toLowerCase()]);
  if (p.designModule?.studyType) facts.push(['type', p.designModule.studyType.toLowerCase()]);
  const alloc = p.designModule?.designInfo;
  if (alloc?.allocation) {
    facts.push([
      'design',
      [alloc.allocation, alloc.maskingInfo?.masking && `${alloc.maskingInfo.masking} masked`]
        .filter(Boolean)
        .join(', ')
        .toLowerCase(),
    ]);
  }
  const n = p.designModule?.enrollmentInfo;
  // `typeof === 'number'`, not truthiness: an enrollment of 0 on a TERMINATED
  // trial — a study that registered and enrolled nobody — is the single most
  // informative value this field takes, and it was the one value dropped.
  if (typeof n?.count === 'number') {
    facts.push(['enrollment', `${n.count} (${(n.type ?? '').toLowerCase() || 'unspecified'})`]);
  }
  const sponsor = p.sponsorCollaboratorsModule?.leadSponsor?.name;
  if (sponsor) facts.push(['sponsor', sponsor]);
  const conds = p.conditionsModule?.conditions;
  if (conds?.length) facts.push(['conditions', conds.slice(0, 6).join('; ')]);
  const ints = p.armsInterventionsModule?.interventions;
  if (ints?.length) {
    facts.push(['interventions', ints.slice(0, 6).map((i) => i.name).filter(Boolean).join('; ')]);
  }
  const primary = p.outcomesModule?.primaryOutcomes;
  if (primary?.length) {
    // What it PRE-REGISTERED. The most useful line on the record when the
    // question is whether a published paper reported what it set out to.
    facts.push([
      'pre-registered primary outcome',
      primary.slice(0, 3).map((o) => o.measure).filter(Boolean).join(' | '),
    ]);
  }
  if (p.statusModule?.startDateStruct?.date) facts.push(['started', p.statusModule.startDateStruct.date]);
  if (primaryDone) facts.push(['primary completion', primaryDone]);
  if (p.statusModule?.whyStopped) facts.push(['why stopped', p.statusModule.whyStopped]);
  facts.push(['results posted', s.hasResults ? (p.statusModule?.resultsFirstPostDateStruct?.date ?? 'yes') : 'no']);

  const stalled = /COMPLETED|TERMINATED/i.test(status);
  const resultsOverdue =
    stalled && !s.hasResults && months !== null && months >= overdueAfter
      ? { months, status: status.toLowerCase(), completed: primaryDone! }
      : null;

  return {
    id: nct ? { kind: 'nct', value: nct, url: nctUrl(nct) } : null,
    alsoIds: [],
    title: (p.identificationModule?.briefTitle ?? p.identificationModule?.officialTitle ?? '').trim(),
    acronym,
    venue: 'ClinicalTrials.gov',
    date: p.statusModule?.startDateStruct?.date,
    year: primaryDone ? Number(primaryDone.slice(0, 4)) : undefined,
    text: p.descriptionModule?.briefSummary?.replace(/\s+/g, ' ').trim().slice(0, 1200),
    ceiling: 'registered',
    retracted: null,
    facts,
    source: 'clinicaltrials',
    resultsOverdue,
  };
}

/** ClinicalTrials.gov v2 accepts overallStatus as a closed, UPPERCASE enum and
 *  answers 400 to anything else; `aggFilters` accepts a bare phase digit and
 *  answers 200 with zero results to anything else — which the caller then
 *  presents to the model as a genuine registry silence. Both are normalised
 *  here so a casing difference cannot become either failure. */
export const TRIAL_STATUSES = [
  'RECRUITING',
  'NOT_YET_RECRUITING',
  'ENROLLING_BY_INVITATION',
  'ACTIVE_NOT_RECRUITING',
  'COMPLETED',
  'SUSPENDED',
  'TERMINATED',
  'WITHDRAWN',
  'UNKNOWN',
] as const;

export type TrialStatus = (typeof TRIAL_STATUSES)[number];

const normalisePhase = (phase: string): string | undefined => {
  const m = /(\d)/.exec(phase);
  return m ? m[1] : undefined;
};

/** `@relevance` is the right default, but it cannot answer "what was registered
 *  recently" — measured 2026-09-09, a relevance search for alzheimer returned
 *  records first posted in 2023, 2018 and 2021, where `StudyFirstPostDate:desc`
 *  returned three from the preceding days. The `frontier` route is told to look
 *  for "recently registered trials" and had no way to ask for them. */
export type TrialSort = 'relevance' | 'newest';

const TRIAL_SORT_FIELD: Record<TrialSort, string> = {
  relevance: '@relevance',
  newest: 'StudyFirstPostDate:desc',
};

export async function searchTrials(
  query: string,
  opts: { limit?: number; status?: string; phase?: string; sort?: TrialSort } = {},
) {
  const { limit = 10, status, phase, sort = 'relevance' } = opts;
  const normalisedStatus = status ? status.trim().toUpperCase().replace(/[\s-]+/g, '_') : undefined;
  const url = `${BASE}?${qs({
    'query.term': query,
    'filter.overallStatus': normalisedStatus,
    'aggFilters': phase ? (normalisePhase(phase) ? `phase:${normalisePhase(phase)}` : undefined) : undefined,
    fields: FIELDS,
    pageSize: limit,
    countTotal: 'true',
    sort: TRIAL_SORT_FIELD[sort],
  })}`;
  const res = await getJson<StudiesResponse>('clinicaltrials', url);
  const records = (res.studies ?? []).map(toRecord);
  return {
    hits: res.totalCount ?? records.length,
    records,
    /** the count the desk reports as a silence, computed not judged */
    overdue: records.filter((r) => r.resultsOverdue).length,
  };
}

/**
 * `null` means the registry answered and has no such study. It does NOT mean
 * "the lookup failed" — a bare `catch { return null }` made a 30s timeout
 * indistinguishable from a genuine absence, and the caller renders null as the
 * positive assertion "it may not exist. Do not write it into an answer as
 * though it resolved." A network failure therefore made the desk deny a real
 * trial. Only a 404 is an absence; everything else propagates.
 */
export async function resolveTrial(nct: string): Promise<TrialRecord | null> {
  const id = nct.trim().toUpperCase();
  if (!/^NCT\d{8}$/.test(id)) return null;
  try {
    const s = await getJson<Study>('clinicaltrials', `${BASE}/${id}?${qs({ fields: FIELDS })}`);
    return toRecord(s);
  } catch (err) {
    if (err instanceof SourceError && err.status === 404) return null;
    throw err;
  }
}
