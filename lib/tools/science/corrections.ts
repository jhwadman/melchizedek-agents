/**
 * desk/sources/corrections.ts — the corrections channel, and the guard that
 * runs before any answer ships.
 *
 * A retracted paper cited as evidence is the one error that makes the whole
 * instrument worthless, so this asks THREE independent signals and takes any
 * of them as a hit:
 *   1. Crossref `updated-by` with a retraction/withdrawal/concern relation
 *      (Crossref carries Retraction Watch's data since 2023).
 *   2. OpenAlex `is_retracted`.
 *   3. The publisher's own title prefix — "RETRACTED:", "WITHDRAWN:".
 * Any one of the three can miss. Verified live 2026-09-08 against
 * 10.1016/S0140-6736(97)11096-0, where all three fired.
 *
 * A LOOKUP THAT FAILS IS NOT A CLEAN BILL. `checked: false` means the desk
 * could not ask, and the answer says "not checked for retraction" rather than
 * saying nothing — the same discipline the parent repo applies to a silence it
 * did not measure.
 */

import { getJson, qs, CONTACT } from './http.ts';
import { bareDoi } from './types.ts';

export interface CorrectionVerdict {
  id: string;
  /** false when every signal errored: an unchecked work, not a clean one */
  checked: boolean;
  retracted: boolean;
  kind?: 'retraction' | 'withdrawal' | 'concern' | 'correction';
  date?: string;
  /** the DOI of the retraction notice, where one exists */
  notice?: string;
  /** the signals that FIRED. Empty on a clean work — which is why it cannot
   *  also serve as "who answered"; see `sources`. */
  signals: string[];
  /** the sources that actually ANSWERED, whether or not they found anything.
   *  A clean bill from one source is not a clean bill from two, and the two
   *  were previously reported in identical words. */
  sources: string[];
  title?: string;
}

const CROSSREF = 'https://api.crossref.org/works';
const OPENALEX = 'https://api.openalex.org/works';

const kindOf = (label: string): CorrectionVerdict['kind'] => {
  const l = label.toLowerCase();
  if (l.includes('retract')) return 'retraction';
  if (l.includes('withdraw')) return 'withdrawal';
  if (l.includes('concern')) return 'concern';
  return 'correction';
};

interface CrossrefWork {
  message?: {
    title?: string[];
    'updated-by'?: Array<{ DOI?: string; type?: string; label?: string; updated?: { 'date-parts'?: number[][] } }>;
  };
}

interface OpenAlexPage {
  results?: Array<{ is_retracted?: boolean; display_name?: string; doi?: string }>;
}

/** normalise anything DOI-shaped to a bare DOI; return null for a PMID etc. */
export function asDoi(id: string): string | null {
  const s = bareDoi(id);
  return /^10\.\d{4,9}\/\S+$/.test(s) ? s : null;
}

export async function checkCorrections(id: string): Promise<CorrectionVerdict> {
  const doi = asDoi(id);
  const out: CorrectionVerdict = { id, checked: false, retracted: false, signals: [], sources: [] };
  if (!doi) {
    // Only a DOI is checkable here. A bare PMID or NCT is resolved to its DOI
    // upstream; when there is none, the answer says the work was not checked.
    out.signals.push('no doi to check');
    return out;
  }

  const [crossref, openalex] = await Promise.allSettled([
    // The DOI is model-chosen: encoded whole as ONE path segment, a value like
    // `10.1234/x/../../members?rows=1000` stays a lookup under /works/ instead
    // of reaching another endpoint. Crossref accepts the encoded slash.
    getJson<CrossrefWork>('crossref', `${CROSSREF}/${encodeURIComponent(doi)}`, { timeoutMs: 15_000 }),
    getJson<OpenAlexPage>(
      'openalex',
      // `select` and `per_page` matter here more than anywhere: this runs for
      // every DOI in every guarded answer, on the critical path before the
      // reply ships. Unselected, one lookup pulls ~36 KB to read one boolean.
      `${OPENALEX}?${qs({
        filter: `doi:${doi}`,
        per_page: 1,
        select: 'id,doi,display_name,is_retracted',
        mailto: CONTACT,
      })}`,
      { timeoutMs: 15_000 },
    ),
  ]);

  if (crossref.status === 'fulfilled') {
    out.checked = true;
    out.sources.push('Crossref');
    const msg = crossref.value.message ?? {};
    out.title = msg.title?.[0];
    for (const u of msg['updated-by'] ?? []) {
      const label = `${u.type ?? ''} ${u.label ?? ''}`;
      if (!/retract|withdraw|concern/i.test(label) && !/retract|withdraw|concern/i.test(u.DOI ?? '')) continue;
      out.retracted = true;
      out.kind = kindOf(label);
      out.notice = u.DOI;
      const parts = u.updated?.['date-parts']?.[0];
      if (parts) out.date = parts.map((n) => String(n).padStart(2, '0')).join('-');
      out.signals.push('crossref');
      break;
    }
    // Crossref's `updated-by` labels a Retraction Watch record "correction"
    // even where the notice DOI is a retraction, so the title is read too.
    if (msg.title?.[0] && /^\s*(RETRACTED|WITHDRAWN)\b/i.test(msg.title[0])) {
      out.retracted = true;
      out.kind ??= kindOf(msg.title[0]);
      if (!out.signals.includes('publisher title')) out.signals.push('publisher title');
    }
  }

  if (openalex.status === 'fulfilled') {
    out.checked = true;
    out.sources.push('OpenAlex');
    const w = openalex.value.results?.[0];
    if (w?.is_retracted) {
      out.retracted = true;
      out.kind ??= 'retraction';
      out.signals.push('openalex');
    }
    if (w?.display_name && !out.title) out.title = w.display_name;
  }

  return out;
}

/** the guard's bulk form: every identifier an answer is about to cite */
export async function checkMany(ids: string[]): Promise<CorrectionVerdict[]> {
  const unique = [...new Set(ids.map((i) => i.trim()).filter(Boolean))];
  const out: CorrectionVerdict[] = [];
  // Serial in small batches: these are free public APIs and a burst from one
  // desk is exactly what gets a pool blocked.
  for (let i = 0; i < unique.length; i += 4) {
    out.push(...(await Promise.all(unique.slice(i, i + 4).map(checkCorrections))));
  }
  return out;
}
