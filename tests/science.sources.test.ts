/**
 * Offline tests for lib/tools/science/*. No network: `fetch` is stubbed and the
 * assertions are about the URL each client BUILDS, which is where this module's
 * bugs have actually lived — a hardcoded sort, a default silently overwritten
 * by a spread, a filter value the API rejects.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { searchLiterature, searchPreprints } from '../lib/tools/science/europepmc.ts';
import { searchTrials } from '../lib/tools/science/trials.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Capture the URL the client requests, and answer with an empty result set. */
function captureUrl(body: unknown = {}): { url: () => string } {
  let seen = '';
  globalThis.fetch = (async (input: any) => {
    seen = String(input);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { url: () => decodeURIComponent(seen) };
}

test('search_preprints defaults to NEWEST first, not most-cited', async () => {
  const cap = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchPreprints('alzheimer', 3);
  // The whole point of reading a preprint is recency; a preprint posted last
  // week has no citations, so `CITED desc` returns the OLDEST of the set and
  // the `frontier` route could not see new work at all.
  assert.match(cap.url(), /sort=P_PDATE_D desc/);
});

test('an omitted sort does not overwrite the preprint default', async () => {
  const cap = captureUrl({ hitCount: 0, resultList: { result: [] } });
  // The contract always passes the key, with `undefined` when the model omitted
  // it. `{ sort: 'recent', ...opts }` spread that undefined over the default and
  // silently restored citation ordering while the header still said "newest
  // first" — a lie the types could not catch.
  await searchPreprints('alzheimer', 3, { sort: undefined, sinceYear: undefined });
  assert.match(cap.url(), /sort=P_PDATE_D desc/);
});

test('an explicit sort still overrides the default', async () => {
  const cap = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchPreprints('alzheimer', 3, { sort: 'cited' });
  assert.match(cap.url(), /sort=CITED desc/);
});

test('search_literature stays citation-ordered unless asked otherwise', async () => {
  const cap = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchLiterature('alzheimer', 3);
  assert.match(cap.url(), /sort=CITED desc/);

  const cap2 = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchLiterature('alzheimer', 3, { sort: 'recent' });
  assert.match(cap2.url(), /sort=P_PDATE_D desc/);
});

test('sinceYear becomes a Europe PMC date clause on the query', async () => {
  const cap = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchLiterature('alzheimer', 3, { sinceYear: 2026 });
  assert.match(cap.url(), /FIRST_PDATE:\[2026-01-01 TO 3000-12-31\]/);
});

test('sinceYear is omitted entirely when unset', async () => {
  const cap = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchLiterature('alzheimer', 3);
  assert.ok(!cap.url().includes('FIRST_PDATE'));
});

test('the SRC: filter is chosen by code on both literature channels', async () => {
  const lit = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchLiterature('x', 1);
  assert.match(lit.url(), /\(SRC:MED OR SRC:PMC\)/);

  const ppr = captureUrl({ hitCount: 0, resultList: { result: [] } });
  await searchPreprints('x', 1);
  assert.match(ppr.url(), /AND SRC:PPR/);
});

test('search_trials normalises status casing and the phase filter', async () => {
  const cap = captureUrl({ totalCount: 0, studies: [] });
  // ClinicalTrials.gov 400s on `Recruiting` and returns a silent zero-result
  // page for `phase:PHASE2`, which block() then presents as a real silence.
  await searchTrials('x', { status: 'Recruiting', phase: 'Phase 2' });
  assert.match(cap.url(), /filter\.overallStatus=RECRUITING/);
  assert.match(cap.url(), /aggFilters=phase:2/);
});

test('search_trials can order by registration date for the frontier route', async () => {
  const cap = captureUrl({ totalCount: 0, studies: [] });
  await searchTrials('x', { sort: 'newest' });
  assert.match(cap.url(), /sort=StudyFirstPostDate:desc/);

  const cap2 = captureUrl({ totalCount: 0, studies: [] });
  await searchTrials('x');
  assert.match(cap2.url(), /sort=@relevance/);
});

test('an unrecognised phase is dropped rather than sent as a dead filter', async () => {
  const cap = captureUrl({ totalCount: 0, studies: [] });
  await searchTrials('x', { phase: 'banana' });
  // Sent through, it returns 200 with zero results — indistinguishable from a
  // genuine registry silence.
  assert.ok(!cap.url().includes('aggFilters'));
});

test('a model-chosen DOI cannot leave the /works/ path at Crossref', async () => {
  const { checkCorrections } = await import('../lib/tools/science/corrections.ts');
  const seen: string[] = [];
  globalThis.fetch = (async (input: any) => {
    seen.push(String(input));
    return new Response(JSON.stringify({ message: {}, results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await checkCorrections('10.1234/x/../../members?rows=1000');
  } finally {
    globalThis.fetch = realFetch;
  }
  const crossref = seen.find((u) => u.startsWith('https://api.crossref.org/'));
  assert.ok(crossref, 'crossref was called');
  assert.ok(crossref!.startsWith('https://api.crossref.org/works/10.1234%2Fx%2F..%2F..%2Fmembers%3Frows%3D1000'), crossref);
  assert.equal(new URL(crossref!).pathname.split('/').length, 3, 'one path segment under /works/');
});
