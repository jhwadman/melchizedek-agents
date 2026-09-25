/**
 * Offline tests for lib/guards/science.ts. No network: the ledger is fed the
 * printed blocks scienceTools.ts emits, and the retraction lookup is stubbed.
 * The name-correspondence cases are the sentence shapes an earlier pairing
 * rule got wrong; a guard that flags correct prose is worse than none.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { IdLedger, checkNames, runGuards, extractIdentifiers } from '../lib/guards/science.ts';
import { printRecord } from '../lib/tools/scienceTools.ts';
import type { Record_ } from '../lib/tools/science/types.ts';

const block = (n: number, title: string, nct: string, acronym?: string) =>
  `[${n}] ${title}\n    NCT ${nct} · https://clinicaltrials.gov/study/${nct}\n${acronym ? `    ACRONYM: ${acronym}\n` : ''}    CEILING: registered — nothing from this record may be graded above it\n    status: completed`;

const toolText = ['TRIAL REGISTRY · query: aducanumab', '',
  block(1, '221AD301 Phase 3 Study of Aducanumab', 'NCT02477800', 'ENGAGE'),
  block(2, '221AD302 Phase 3 Study of Aducanumab', 'NCT02484547', 'EMERGE'),
  block(3, 'Semaglutide Effects on Heart Disease', 'NCT03574597', 'SELECT'),
  block(4, 'An unnamed trial', 'NCT01234567'),
].join('\n\n');

const ledger = new IdLedger();
ledger.noteFromToolText(toolText);
const link = (nct: string) => `[${nct}](https://clinicaltrials.gov/study/${nct})`;

test('the ledger recovers names from printed blocks', () => {
  assert.strictEqual(ledger.acronymOf('NCT02477800'), 'ENGAGE');
  assert.strictEqual(ledger.acronymOf('NCT02484547'), 'EMERGE');
  assert.strictEqual(ledger.acronymOf('NCT01234567'), undefined);
  assert.ok(ledger.has('NCT03574597'));
});

test('identifier extraction keeps a parenthesised DOI whole', () => {
  assert.deepStrictEqual(extractIdentifiers('see 10.1016/S0140-6736(97)11096-0.').doi, ['10.1016/S0140-6736(97)11096-0']);
});

for (const [label, text] of [
  ['the swap this guard exists for', `EMERGE (${link('NCT02477800')}) and ENGAGE (${link('NCT02484547')}).`],
  ['identifier first, name after', `The trial ${link('NCT02477800')} (EMERGE) enrolled 1,653.`],
  ['a list, swapped', `EMERGE and ENGAGE (${link('NCT02477800')}, ${link('NCT02484547')}) were halted.`],
] as const) {
  test(`fires: ${label}`, () => assert.ok(checkNames(text, ledger).length > 0));
}

for (const [label, text] of [
  ['correct pairing', `EMERGE (${link('NCT02484547')}) and ENGAGE (${link('NCT02477800')}).`],
  ['a correct list', `EMERGE and ENGAGE (${link('NCT02484547')}, ${link('NCT02477800')}) were halted.`],
  ['an endpoint in capitals', `Both measured CDR-SB at week 78 (${link('NCT02484547')}).`],
  ['one name spanning two identifiers', `The EMERGE programme spans ${link('NCT02484547')} and ${link('NCT02477800')}.`],
  ['a record the registry gave no acronym', `The trial (${link('NCT01234567')}) is unrelated.`],
] as const) {
  test(`silent: ${label}`, () => assert.deepStrictEqual(checkNames(text, ledger), []));
}

test('closure marks an ungrounded identifier in place and leaves grounded ones alone', async () => {
  const report = await runGuards(
    `EMERGE (${link('NCT02484547')}) and 10.9999/fabricated.2026.1 report this.`,
    ledger,
    { checkMany: async () => [] },
  );
  assert.deepStrictEqual(report.closure.unclosed, ['10.9999/fabricated.2026.1']);
  assert.ok(report.answer.includes('[UNVERIFIED IDENTIFIER'));
  assert.ok(!/NCT02484547[^)]*UNVERIFIED/.test(report.answer));
});

/* ── the ledger is fed by the REAL printer ────────────────────────────────────
   The fixtures above hand-write the record layout. That is the gap that let a
   divergence between printRecord and noteFromToolText ship: reorder a line and
   every test here still passes while the guard goes silent in production. The
   cases below build their input with printRecord itself. */

const printed = (records: Record_[], head = 'TRIAL REGISTRY · query: x') =>
  [head, '', ...records.map((r, i) => printRecord(r, i + 1))].join('\n\n');

const trial = (nct: string, title: string, acronym?: string): Record_ => ({
  id: { kind: 'nct', value: nct, url: `https://clinicaltrials.gov/study/${nct}` },
  alsoIds: [],
  title,
  acronym,
  ceiling: 'registered',
  source: 'clinicaltrials',
});

test('the ledger reads the real printRecord layout, acronym included', () => {
  const l = new IdLedger();
  l.noteFromToolText(printed([trial('NCT09999991', 'A study', 'ALPHA')]));
  assert.ok(l.has('NCT09999991'));
  assert.strictEqual(l.acronymOf('NCT09999991'), 'ALPHA');
});

test("a record's alsoIds reach the ledger, so citing by PMID closes", () => {
  const l = new IdLedger();
  l.noteFromToolText(
    printed(
      [{
        id: { kind: 'doi', value: '10.1056/NEJMoa2307563', url: 'https://doi.org/10.1056/NEJMoa2307563' },
        alsoIds: [{ kind: 'pmid', value: '37952131', url: 'https://pubmed.ncbi.nlm.nih.gov/37952131/' }],
        title: 'A paper',
        ceiling: 'reported',
        source: 'europepmc',
      }],
      'PEER-REVIEWED LITERATURE · query: x',
    ),
  );
  // The grade ladder lets an answer cite by DOI *or* PMID; both must close.
  assert.ok(l.has('10.1056/NEJMoa2307563'));
  assert.ok(l.has('37952131'));
});

/* ── closure cannot be laundered through a tool's own echo ─────────────────── */

test('a tool echoing its argument does NOT close the identifier', async () => {
  const l = new IdLedger();
  // Exactly what check_retraction returns, and the evidence prompts instruct the
  // agent to call it on every DOI it cites. Harvesting the head line let a
  // fabricated DOI close itself.
  l.noteFromToolText(
    'RETRACTION CHECK · 10.9999/invented.2026.1 — no retraction, withdrawal or expression of concern recorded by Crossref or OpenAlex.',
  );
  assert.ok(!l.has('10.9999/invented.2026.1'));

  const report = await runGuards('It is established (10.9999/invented.2026.1).', l, {
    checkMany: async () => [],
  });
  assert.deepStrictEqual(report.closure.unclosed, ['10.9999/invented.2026.1']);
  assert.ok(report.answer.includes('[UNVERIFIED IDENTIFIER'));
});

test('a resolve miss does not close the identifier it echoes', () => {
  const l = new IdLedger();
  l.noteFromToolText('RESOLVE NCT07777777 — NO RECORD. This identifier resolved to nothing.');
  assert.ok(!l.has('NCT07777777'));
});

/* ── markers are spliced, never substring-replaced ─────────────────────────── */

test('a marker never lands inside a markdown link target', async () => {
  const report = await runGuards(
    `DOI: [10.9999/fake.2026.1](https://doi.org/10.9999/fake.2026.1) is the source.`,
    new IdLedger(),
    { checkMany: async () => [] },
  );
  assert.ok(report.answer.includes('[10.9999/fake.2026.1 [UNVERIFIED IDENTIFIER'));
  // The href must survive intact or the link renders as literal text.
  assert.ok(report.answer.includes('](https://doi.org/10.9999/fake.2026.1)'));
});

test('an ungrounded short id does not corrupt a grounded longer one', async () => {
  const l = new IdLedger();
  l.noteFromToolText(printed([trial('NCT01234567', 'A study')]));
  const report = await runGuards(
    'See PMID: 123456 for the protocol; the trial is NCT01234567.',
    l,
    { checkMany: async () => [] },
  );
  // PMIDs are extracted as bare digits, so a substring replace split the NCT.
  assert.ok(report.answer.includes('the trial is NCT01234567.'));
  assert.ok(report.answer.includes('PMID: 123456 [UNVERIFIED IDENTIFIER'));
});

test('a grounded DOI followed by an em dash or bold is not flagged', async () => {
  const l = new IdLedger();
  l.add('10.1056/NEJMoa2212948');
  for (const answer of [
    'Lecanemab slowed decline (10.1056/NEJMoa2212948—an 18-month phase 3).',
    'Reported in **10.1056/NEJMoa2212948** last year.',
    'Reported in `10.1056/NEJMoa2212948` last year.',
  ]) {
    const report = await runGuards(answer, l, { checkMany: async () => [] });
    assert.deepStrictEqual(report.closure.unclosed, [], `should be closed: ${answer}`);
    assert.strictEqual(report.answer, answer, `should be untouched: ${answer}`);
  }
});

/* ── name correspondence ───────────────────────────────────────────────────── */

test('an acronym carrying a regex metacharacter does not throw the guard', async () => {
  const l = new IdLedger();
  l.noteFromToolText(printed([trial('NCT11111111', 'One', 'A(B'), trial('NCT22222222', 'Two', 'CDE')]));
  // Must not reject: a throw here reaches a2a_server, which then never assigns
  // finalText — discarding the closure markers and shipping the answer with the
  // fabricated DOI unmarked.
  const report = await runGuards(
    'A(B (NCT22222222) reported it; see 10.9999/fabricated.2026.1 too.',
    l,
    { checkMany: async () => [] },
  );
  assert.ok(report.answer.includes('[UNVERIFIED IDENTIFIER'));
  assert.strictEqual(report.names.length, 1);
});

test('an id-before-name mismatch is actually marked, not just reported', async () => {
  const report = await runGuards(
    `The trial ${link('NCT02477800')} (EMERGE) enrolled 1,653.`,
    ledger,
    { checkMany: async () => [] },
  );
  assert.strictEqual(report.names.length, 1);
  // The note used to claim "marked in place" over text nothing had touched.
  assert.ok(report.answer.includes('[NAME MISMATCH'));
});

test('a mixed-case registry acronym is still checked', () => {
  const l = new IdLedger();
  l.noteFromToolText(
    printed([trial('NCT04788511', 'One', 'STEP-HFpEF'), trial('NCT03574597', 'Two', 'SELECT')]),
  );
  // Spelled the way the registry spells it — the casing an agent will copy.
  assert.strictEqual(checkNames('STEP-HFpEF (NCT03574597) met its endpoint.', l).length, 1);
});

test('a hyphenated sibling acronym is not mistaken for its shorter prefix', () => {
  const l = new IdLedger();
  l.noteFromToolText(
    printed([trial('NCT00887328', 'One', 'EXTEND'), trial('NCT02388061', 'Two', 'EXTEND-IA')]),
  );
  // EXTEND matched *inside* EXTEND-IA and reported a swap in correct prose.
  assert.deepStrictEqual(checkNames('EXTEND-IA (NCT02388061) showed benefit.', l), []);
});

test('prose that asserts no correspondence is left unjudged', () => {
  assert.deepStrictEqual(
    checkNames(
      'Both EMERGE and ENGAGE enrolled about 1,650 patients, and the registry entries are NCT02477800 and NCT02484547.',
      ledger,
    ),
    [],
  );
});

test('an acronym is bound to its own record, not a trial named in the title', () => {
  const l = new IdLedger();
  l.noteFromToolText(printed([trial('NCT02477800', '221AD301, companion to NCT02484547', 'ENGAGE')]));
  assert.strictEqual(l.acronymOf('NCT02477800'), 'ENGAGE');
  assert.strictEqual(l.acronymOf('NCT02484547'), undefined);
});

/* ── a failed lookup is not a clean bill ───────────────────────────────────── */

test('a retraction lookup that reached no source is annotated and noted', async () => {
  const l = new IdLedger();
  l.add('10.1016/S0140-6736(97)11096-0');
  const report = await runGuards(
    'The original report (10.1016/S0140-6736(97)11096-0) claimed a link.',
    l,
    {
      // Both sources rejected: checked=false. This used to be dropped by the
      // `.retracted` filter and recorded nowhere, so an outage read as clean.
      checkMany: async (ids) =>
        ids.map((id) => ({ id, checked: false, retracted: false, signals: [], sources: [] })),
    },
  );
  assert.ok(report.unchecked.includes('10.1016/S0140-6736(97)11096-0'));
  assert.ok(report.answer.includes('[NOT CHECKED FOR RETRACTION'));
  assert.ok(report.notes.some((n) => n.includes('could not be checked')));
});
