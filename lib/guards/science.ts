/**
 * lib/guards/science.ts — what runs AFTER an agent writes and BEFORE the
 * reader reads. Arithmetic and lookups, never a second opinion from a model.
 *
 * Ported from the science desk (2026-09-08) into the A2A engine's guard hook
 * (lib/guards/index.ts): the ledger is fed from every tool-result TEXT of the
 * answering turn, which is all an engine sees, and scienceTools.ts prints its
 * records so that text carries everything the guards need.
 *
 * The parent instrument's lesson, ported: a retry cannot fix a prompt-level
 * failure, because at temperature 0 the same prompt returns the same sentence.
 * So the guards do not re-ask. They measure what came back and rewrite or
 * refuse.
 *
 * TWO GUARDS.
 *
 * 1. IDENTIFIER CLOSURE. Every NCT, DOI and PMID in the answer must appear in
 *    a tool result from THIS run. A model that writes a plausible DOI is the
 *    highest-frequency failure of any literature agent, and it is invisible to
 *    a reader — the string is well-formed, the journal is real, the paper is
 *    not. Set difference, no model call, no ambiguity.
 *
 * 2. RETRACTION. Every identifier that survives closure goes through the
 *    corrections channel before the answer ships. A work that comes back
 *    retracted is annotated in place; the answer is not silently deleted,
 *    because a reader who was about to be told something wrong is owed the
 *    reason.
 */

import { checkMany as liveCheckMany, asDoi, type CorrectionVerdict } from '../tools/science/corrections.ts';

/** The dials, formerly a taxonomy block. A guard is engine code now and
 *  carries its own; set to false only for a syndicate that has opted out by
 *  not naming the guard at all, which is the supported way. */
const GUARDS = { identifier_closure: true, retraction_check: true, name_correspondence: true } as const;

/* Strict on the DOI's head (10.x/ is the registered shape), loose on its tail,
   which may carry almost anything — INCLUDING PARENTHESES. Elsevier and the
   Lancet mint them by the thousand (10.1016/S0140-6736(97)11096-0), so a
   character class that excludes `)` truncates the DOI at the first bracket
   and hands the guards an identifier that resolves to nothing. The tail is
   therefore matched greedily and trimmed afterwards: sentence punctuation
   comes off the end, and a closing bracket comes off only while it is
   unbalanced, which is what distinguishes a DOI's own parens from the ones a
   sentence wrapped around it.

   The class also excludes the characters an LLM wraps a citation in but a DOI
   never contains — backtick, asterisk, underscore-pair, em and en dash. Left in,
   they were absorbed into the match: `10.1056/NEJMoa2212948—an 18-month trial`
   extracted `10.1056/NEJMoa2212948—an`, which is in no ledger, so a correctly
   grounded citation shipped stamped UNVERIFIED with the prose mangled around
   it. Em dashes and bold are the commonest formatting a model puts near a DOI. */
const RE = {
  nct: /\bNCT\d{8}\b/gi,
  doi: /\b10\.\d{4,9}\/[^\s"'<>\]}`*–—]+/gi,
  pmid: /\bPMID:?\s*(\d{6,9})\b/gi,
  pmcid: /\bPMC\d{6,9}\b/gi,
};

function trimTail(raw: string): string {
  let s = raw.replace(/[.,;:]+$/, '');
  for (;;) {
    if (s.endsWith(')')) {
      const opens = (s.match(/\(/g) ?? []).length;
      const closes = (s.match(/\)/g) ?? []).length;
      if (closes > opens) {
        s = s.slice(0, -1).replace(/[.,;:]+$/, '');
        continue;
      }
    }
    return s;
  }
}

export interface Extracted {
  nct: string[];
  doi: string[];
  pmid: string[];
  pmcid: string[];
  all: string[];
}

/** dedupe case-insensitively while KEEPING the casing the text used: a DOI is
 *  case-insensitive to resolve and case-sensitive to string-replace, and the
 *  guards do both. */
function uniqueKeepingCase(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function extractIdentifiers(text: string): Extracted {
  const nct = uniqueKeepingCase((text.match(RE.nct) ?? []).map((s) => s.toUpperCase()));
  const doi = uniqueKeepingCase((text.match(RE.doi) ?? []).map(trimTail));
  const pmcid = uniqueKeepingCase((text.match(RE.pmcid) ?? []).map((s) => s.toUpperCase()));
  const pmid: string[] = [];
  for (const m of text.matchAll(RE.pmid)) if (m[1]) pmid.push(m[1]);
  const uniquePmid = uniqueKeepingCase(pmid);
  return { nct, doi, pmid: uniquePmid, pmcid, all: [...nct, ...doi, ...uniquePmid, ...pmcid] };
}

/** the identifiers a run actually saw, accumulated as tool results come back */
export class IdLedger {
  private seen = new Set<string>();
  /** identifier -> the short name its own source assigned it */
  private names = new Map<string, string>();

  add(...ids: Array<string | null | undefined>): void {
    for (const id of ids) if (id) this.seen.add(id.trim().toLowerCase());
  }

  /** Record what a source called a record. Closure proves an identifier
   *  EXISTS; this is what lets a later check ask whether the name attached to
   *  it is the name that source gave it. */
  note(id: string | null | undefined, acronym?: string): void {
    if (!id) return;
    const key = id.trim().toLowerCase();
    this.seen.add(key);
    if (acronym) this.names.set(key, acronym.trim());
  }

  acronymOf(id: string): string | undefined {
    return this.names.get(id.trim().toLowerCase());
  }

  /**
   * Learn names and identifiers from a tool's printed output.
   *
   * ONLY RECORD BLOCKS COUNT. Every tool in scienceTools.ts opens with a head
   * line that echoes the arguments it was called with — `RETRACTION CHECK ·
   * <doi> — …`, `RESOLVE <id> — NO RECORD`, `… · query: <query> · …`. Harvesting
   * the whole text meant a model could launder a fabricated identifier into the
   * ledger merely by CALLING a tool on it, and the evidence prompts instruct exactly
   * that ("Call `check_retraction` on every DOI you cite"), so the integrity
   * step the prompt mandates was what disabled the guard: closure passed, notes
   * were empty, and the invented citation shipped unmarked.
   *
   * A record block is what a source actually RETURNED. Its identifier line, its
   * ACRONYM line and its verbatim abstract are all source-authored; the head
   * line is not. Note that `check_retraction` therefore no longer closes an
   * identifier on its own — correctly: it reports whether a retraction is
   * recorded, which is not evidence that the work exists.
   */
  noteFromToolText(text: string): void {
    const records = text.split(/\n(?=\[\d+\] )/).filter((b) => /^\[\d+\]\s/.test(b));
    for (const block of records) {
      // Anchored to the identifier LINE, not to the first match anywhere in the
      // block: a registry title that cross-references a companion trial
      // ("221AD301, companion to NCT02484547") otherwise handed this record's
      // acronym to a different trial, blinding the guard on one and giving the
      // other a name it does not own.
      const id =
        /^\s*NCT\s+(NCT\d{8})\b/mi.exec(block)?.[1] ?? /^\s*(NCT\d{8})\b/mi.exec(block)?.[1];
      const acronym = /^\s*ACRONYM:\s*(.+?)\s*$/m.exec(block)?.[1];
      if (id) this.note(id, acronym);
    }
    this.harvest(records.join('\n'));
  }

  /** every short name this run saw, and which identifier carried it */
  knownNames(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, name] of this.names) out.set(name.toUpperCase(), id);
    return out;
  }

  /** every identifier anywhere in a tool result, so a record's own text counts */
  harvest(payload: unknown): void {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? '');
    const found = extractIdentifiers(text);
    this.add(...found.all);
  }

  has(id: string): boolean {
    return this.seen.has(id.trim().toLowerCase());
  }

  get size(): number {
    return this.seen.size;
  }

  list(): string[] {
    return [...this.seen];
  }
}

export interface ClosureResult {
  ok: boolean;
  /** identifiers the answer cites that no tool result carried */
  unclosed: string[];
  cited: string[];
}

export function closeIdentifiers(answer: string, ledger: IdLedger): ClosureResult {
  if (!GUARDS.identifier_closure) return { ok: true, unclosed: [], cited: [] };
  const cited = extractIdentifiers(answer).all;
  const unclosed = cited.filter((id) => !ledger.has(id));
  return { ok: unclosed.length === 0, unclosed, cited };
}

/* ── name correspondence ──────────────────────────────────────────────────────
   Identifier closure proves an identifier EXISTS. It cannot prove the study
   NAME beside it is that identifier's name, and the two failures look nothing
   alike to a reader: a fabricated DOI resolves to nothing, while a swapped
   acronym resolves perfectly to the wrong study. One capture of this desk
   reported EMERGE as NCT02477800; the registry calls that trial ENGAGE. Both
   identifiers were real, both closed, and the answer was wrong.

   The check is deliberately narrow, because a false positive here is worse
   than a miss: it compares an acronym THE ANSWER used against the acronym THE
   REGISTRY returned for the identifier beside it, and fires only when the name
   the answer used belongs to a different record the same run read. That is the
   swap, exactly. A name no source assigned is a different defect and is not
   this guard's business. */

export interface NameMismatch {
  /** the name the answer used */
  claimed: string;
  /** the identifier it attached that name to */
  id: string;
  /** the name that identifier's own source assigned */
  actual: string;
  /** the identifier the claimed name actually belongs to */
  belongsTo: string;
  /** where `claimed` sits in the text checkNames was given, so the annotation
   *  can be spliced at the occurrence that was actually judged rather than
   *  re-found by a second, differently-written regex */
  at: number;
  end: number;
}

/** how far apart a name and an identifier may sit and still be read as a pair */
const REACH = 120;

interface Hit {
  kind: 'name' | 'id';
  text: string;
  at: number;
  end: number;
}

function occurrences(text: string, re: RegExp, kind: Hit['kind'], offset = 0): Hit[] {
  const out: Hit[] = [];
  for (const m of text.matchAll(re)) {
    const at = (m.index ?? 0) + offset;
    out.push({ kind, text: m[0].toUpperCase(), at, end: at + m[0].length });
  }
  return out;
}

/**
 * A markdown link to a trial writes its identifier TWICE: once as the label and
 * once inside the URL, `[NCT02477800](https://clinicaltrials.gov/study/NCT02477800)`.
 * Left alone that is two identifier hits for one citation, which turns a run of
 * one name and one identifier into one-against-two and made the pairing decline
 * to judge every real answer this desk produces. Collapse consecutive
 * repetitions of the same identifier into the citation they are.
 */
function collapse(hits: Hit[]): Hit[] {
  const out: Hit[] = [];
  for (const hit of hits) {
    const last = out[out.length - 1];
    if (last && last.kind === 'id' && hit.kind === 'id' && last.text === hit.text) {
      last.end = hit.end;
      continue;
    }
    out.push({ ...hit });
  }
  return out;
}

/** consecutive hits of one kind, in document order */
function runs(hits: Hit[]): Hit[][] {
  const out: Hit[][] = [];
  for (const hit of hits) {
    const last = out[out.length - 1];
    if (last && last[0]!.kind === hit.kind) last.push(hit);
    else out.push([hit]);
  }
  return out;
}

/**
 * Pair each study name with the identifier the answer attaches it to.
 *
 * Proximity alone is wrong, and the failing case is ordinary prose: "EMERGE and
 * ENGAGE (NCT02484547, NCT02477800)" puts ENGAGE nearer the FIRST identifier
 * than its own, and a nearest-neighbour rule reports a swap that is not there.
 * Names and identifiers are therefore paired by RUN: a run of names followed by
 * a run of identifiers of the same length pairs by index, and anything that
 * does not resolve to an unambiguous pairing is left unjudged. A guard that
 * cannot tell which identifier a name belongs to must say nothing, not guess.
 */
/**
 * What may sit BETWEEN a run of names and the run of identifiers it is read as
 * labelling: brackets, quotes and punctuation only.
 *
 * Run-pairing alone was not narrow enough. "Both EMERGE and ENGAGE enrolled
 * about 1,650 patients, and the registry entries are NCT02477800 and
 * NCT02484547" is two names followed by two identifiers within the reach
 * window, and the sentence asserts NO correspondence between them — yet it was
 * read as a `respectively` list and two mismatches were reported against
 * correct prose. A citation attaches its identifier with brackets, not with a
 * clause: if there are words in the gap, this guard has no basis to pair.
 */
const GAP_IS_PUNCTUATION = /^[\s()[\]{}<>.,:;'"·|–—-]*$/;

function pairs(hits: Hit[], text: string): Array<[name: Hit, id: Hit]> {
  const out: Array<[Hit, Hit]> = [];
  const blocks = runs(hits);
  // Blocks are CONSUMED in pairs. Sliding one block at a time would read
  // "EMERGE (id1) and ENGAGE (id2)" three ways: EMERGE with id1, then id1 with
  // ENGAGE, then ENGAGE with id2. The middle reading is the artefact of the
  // window, not of the sentence, and it reported a swap in correct prose.
  for (let i = 0; i < blocks.length - 1; ) {
    const a = blocks[i]!;
    const b = blocks[i + 1]!;
    // Unequal runs are ambiguous ("the EMERGE programme spans id1 and id2"),
    // and so is a gap wide enough to cross a sentence. Neither is judged.
    const gapFrom = a[a.length - 1]!.end;
    const gapTo = b[0]!.at;
    if (a.length !== b.length || gapTo - gapFrom > REACH) {
      i++;
      continue;
    }
    // Words in the gap mean the sentence is SAYING something about the
    // relation rather than citing it. Not judged.
    if (!GAP_IS_PUNCTUATION.test(text.slice(gapFrom, gapTo))) {
      i++;
      continue;
    }
    for (let k = 0; k < a.length; k++) {
      const [name, id] = a[0]!.kind === 'name' ? [a[k]!, b[k]!] : [b[k]!, a[k]!];
      out.push([name, id]);
    }
    i += 2;
  }
  return out;
}

export function checkNames(answer: string, ledger: IdLedger): NameMismatch[] {
  if (!GUARDS.name_correspondence) return [];
  const known = ledger.knownNames();
  if (!known.size) return [];

  // Only names this run actually read are candidates. A token in capitals that
  // no source assigned to a record is a drug, a scale, a sponsor or a word, and
  // this guard has no basis on which to rule about it.
  //
  // LONGEST FIRST: JS alternation is leftmost-first and `\b` treats `-` as a
  // boundary, so with EXTEND listed before EXTEND-IA the pattern matched
  // EXTEND *inside* EXTEND-IA and reported a mismatch on correct prose.
  // Sibling acronyms of that shape are the norm in trial registries
  // (EXTEND/EXTEND-IA, CLARITY/CLARITY-AD, STEP/STEP-HFpEF).
  //
  // CASE-INSENSITIVE: knownNames() uppercases its keys, so a case-sensitive
  // pattern could never match a registry acronym spelled the way the registry
  // spells it — STEP-HFpEF went unmatched and a genuine swap passed silently.
  const namePattern = new RegExp(
    `\\b(${[...known.keys()]
      .sort((x, y) => y.length - x.length)
      .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|')})\\b`,
    'gi',
  );

  const hits = collapse(
    [...occurrences(answer, RE.nct, 'id'), ...occurrences(answer, namePattern, 'name')].sort(
      (x, y) => x.at - y.at,
    ),
  );

  const out: NameMismatch[] = [];
  const seen = new Set<string>();

  for (const [name, id] of pairs(hits, answer)) {
    const actual = ledger.acronymOf(id.text);
    // No acronym on the record means the registry assigned none: unmeasured,
    // never a mismatch.
    if (!actual) continue;
    if (name.text === actual.toUpperCase()) continue;

    const belongsTo = known.get(name.text);
    if (!belongsTo || belongsTo.toUpperCase() === id.text) continue;

    const key = `${name.text}:${id.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      // The casing the ANSWER used, not the uppercased ledger key: the
      // annotation is spliced over this exact span.
      claimed: answer.slice(name.at, name.end),
      id: id.text,
      actual,
      belongsTo: belongsTo.toUpperCase(),
      at: name.at,
      end: name.end,
    });
  }
  return out;
}

/* ── annotation ───────────────────────────────────────────────────────────────
   Markers are spliced at MATCH OFFSETS, never by `split(id).join(marker)`.

   The bare substring replace was wrong three ways at once, all of them
   reproducible:

     · It matched inside a LONGER identifier. PMIDs are extracted as bare
       digits, so an ungrounded 7-digit PMID rewrote the grounded 8-digit NCT
       that contained it: `NCT01234567` shipped as
       `NCT0123456 [UNVERIFIED IDENTIFIER: …]7` — a correct citation cut in half
       and falsely accused.
     · It matched inside the URL of a markdown link, which is the citation shape
       the evidence prompts mandate. The href was destroyed and half the warning
       landed where no reader would ever see it.
     · It marked every occurrence of the string, including ones that were not
       identifier matches at all.

   Positions come from the same regexes closure used, so what gets marked is
   exactly what got judged. */

interface IdSpan {
  at: number;
  end: number;
  /** the normalised identifier, for comparison against the ledger */
  id: string;
}

/** the URL half of a markdown link, `](…)` — never annotated */
function linkTargetRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/\]\(([^)]*)\)/g)) {
    const start = (m.index ?? 0) + 2;
    out.push([start, start + (m[1]?.length ?? 0)]);
  }
  return out;
}

function identifierSpans(text: string): IdSpan[] {
  const spans: IdSpan[] = [];
  const add = (at: number, raw: string) => {
    if (raw) spans.push({ at, end: at + raw.length, id: raw });
  };
  for (const m of text.matchAll(RE.nct)) add(m.index ?? 0, m[0]);
  for (const m of text.matchAll(RE.pmcid)) add(m.index ?? 0, m[0]);
  for (const m of text.matchAll(RE.doi)) add(m.index ?? 0, trimTail(m[0]));
  for (const m of text.matchAll(RE.pmid)) {
    // Mark the digits, not the `PMID:` label in front of them.
    const digits = m[1];
    if (digits) add((m.index ?? 0) + m[0].lastIndexOf(digits), digits);
  }
  return spans.sort((a, b) => a.at - b.at);
}

/** Append `markerFor(id)` after each identifier occurrence it returns a marker
 *  for, back to front so earlier offsets stay valid. */
function annotate(text: string, markerFor: (id: string) => string | null): string {
  const targets = linkTargetRanges(text);
  const spans = identifierSpans(text).filter(
    (s) => !targets.some(([lo, hi]) => s.at >= lo && s.end <= hi),
  );
  let out = text;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i]!;
    const marker = markerFor(span.id);
    if (marker) out = out.slice(0, span.end) + marker + out.slice(span.end);
  }
  return out;
}

export interface GuardReport {
  closure: ClosureResult;
  retractions: CorrectionVerdict[];
  names: NameMismatch[];
  /** cited identifiers the corrections channel did not clear: those it cannot
   *  check (not a DOI) and those it could not reach (every source rejected).
   *  Both are annotated in `answer` and reported in `notes` — an unchecked work
   *  that reaches the reader looking checked is the failure this exists for. */
  unchecked: string[];
  /** the answer as it should ship: annotated where a guard fired */
  answer: string;
  /** one line per guard that fired, for the event stream and the log */
  notes: string[];
}

export interface GuardOptions {
  /** the corrections lookup; injectable so tests run offline */
  checkMany?: (ids: string[]) => Promise<CorrectionVerdict[]>;
}

export async function runGuards(answer: string, ledger: IdLedger, opts: GuardOptions = {}): Promise<GuardReport> {
  const checkMany = opts.checkMany ?? liveCheckMany;
  const notes: string[] = [];
  const closure = closeIdentifiers(answer, ledger);
  let out = answer;

  if (!closure.ok) {
    // NOT a silent deletion, and not a retry. The sentence stays, marked, so
    // the reader sees exactly which citation the desk could not stand behind.
    const unclosed = new Set(closure.unclosed.map((id) => id.toLowerCase()));
    out = annotate(out, (id) =>
      unclosed.has(id.toLowerCase())
        ? ' [UNVERIFIED IDENTIFIER: no source in this run returned it]'
        : null,
    );
    notes.push(
      `identifier closure: ${closure.unclosed.length} of ${closure.cited.length} cited identifiers appear in no tool result from this run; marked in place`,
    );
  }

  let retractions: CorrectionVerdict[] = [];
  const unchecked: string[] = [];

  if (GUARDS.retraction_check && closure.cited.length) {
    const checkable = closure.cited.filter((id) => asDoi(id));
    // Not a DOI: nothing to ask the corrections channel about.
    unchecked.push(...closure.cited.filter((id) => !asDoi(id)));

    const verdicts = await checkMany(checkable);
    retractions = verdicts.filter((v) => v.retracted);

    // A LOOKUP THAT FAILS IS NOT A CLEAN BILL (corrections.ts:15). A verdict
    // with `checked: false` — both sources rejected — used to be discarded by
    // the `.retracted` filter and recorded nowhere, so an unreachable Crossref
    // and a timed-out OpenAlex produced the same empty `notes` as a work that
    // had genuinely been cleared.
    const couldNotAsk = verdicts.filter((v) => !v.checked).map((v) => v.id);
    unchecked.push(...couldNotAsk);

    if (retractions.length) {
      const byId = new Map(retractions.map((v) => [v.id.toLowerCase(), v]));
      out = annotate(out, (id) => {
        const v = byId.get(id.toLowerCase());
        return v
          ? ` [${(v.kind ?? 'retraction').toUpperCase()}${v.date ? ` ${v.date}` : ''}: this work has been withdrawn and cannot support a claim]`
          : null;
      });
      notes.push(
        `retraction check: ${retractions.length} cited work${retractions.length === 1 ? '' : 's'} withdrawn (${retractions.map((v) => v.signals.join('+')).join('; ')}); marked in place`,
      );
    }

    if (couldNotAsk.length) {
      const marked = new Set(couldNotAsk.map((id) => id.toLowerCase()));
      out = annotate(out, (id) =>
        marked.has(id.toLowerCase())
          ? ' [NOT CHECKED FOR RETRACTION: no corrections source answered for this work]'
          : null,
      );
      notes.push(
        `retraction check: ${couldNotAsk.length} cited work${couldNotAsk.length === 1 ? '' : 's'} could not be checked (no corrections source answered); marked in place — this is not a clean bill`,
      );
    }
  }

  const names = checkNames(out, ledger);
  // Spliced back to front at the offsets checkNames judged. The previous
  // `new RegExp(\`\\b${n.claimed}\\b(?=…${n.id})\`)` was unescaped — a registry
  // acronym containing `(` threw SyntaxError out of runGuards, and because the
  // caller assigns `finalText` only on success, that discarded the closure and
  // retraction markers computed above and shipped the answer wholly unguarded.
  // Its lookahead also only searched FORWARD, so an id-before-name mismatch
  // emitted a note claiming "marked in place" over text nothing had touched.
  for (let i = names.length - 1; i >= 0; i--) {
    const n = names[i]!;
    // Annotated at the NAME rather than the identifier: the identifier is
    // correct and resolvable, and it is the name beside it that is wrong.
    const marker = ` [NAME MISMATCH: ${n.id} is ${n.actual}; ${n.claimed} is ${n.belongsTo}]`;
    out = out.slice(0, n.end) + marker + out.slice(n.end);
  }
  if (names.length) {
    notes.push(
      `name correspondence: ${names.length} study name${names.length === 1 ? '' : 's'} attached to the wrong identifier (${names.map((n) => `${n.claimed} is ${n.belongsTo}, not ${n.id}`).join('; ')}); marked in place`,
    );
  }

  return { closure, retractions, names, unchecked, answer: out, notes };
}
