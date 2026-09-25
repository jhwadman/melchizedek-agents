/**
 * desk/sources/http.ts — one way out to the network, for every source.
 *
 * Every public API this desk reads is free and unauthenticated, and every one
 * of them asks politely for a contact address in the User-Agent so they can
 * mail you before they block you. ASSAY_CONTACT is that address; without it
 * the desk still runs and the pools it uses are slower.
 */

/** The one answer to "what is this desk's contact address". Exported because
 *  OpenAlex wants it as a `mailto=` query parameter as well as in the
 *  User-Agent, and a second local definition had already drifted: it read only
 *  ASSAY_CONTACT, so a deployment setting the namespaced SCIENCE_API_CONTACT
 *  got a polite UA and an empty mailto — the throttled pool, silently. */
export const CONTACT = process.env.SCIENCE_API_CONTACT ?? process.env.ASSAY_CONTACT ?? '';
const UA = `melchizedek-science-tools/1.0 (${CONTACT || 'no contact set'})`;

/** Calls made per source, for the run in progress. OpenAlex meters by call and
 *  publishes the price in its own response headers, so source traffic is a
 *  priced input to this service and not a free one. */
export const CALLS = new Map<string, number>();

export function resetCalls(): void {
  CALLS.clear();
}

export class SourceError extends Error {
  source: string;
  status: number;
  constructor(source: string, status: number, message: string) {
    super(`${source}: ${message}`);
    this.source = source;
    this.status = status;
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  /** retried on a 5xx, a timeout, 429 or 408; every other 4xx is never retried */
  retry?: boolean;
}

/** 429 and 408 are the server asking you to come back, not telling you the
 *  request was wrong. Every source here is a shared free pool that answers 429
 *  under load — and `checkMany` fires four at once — so treating it as terminal
 *  turned ordinary congestion into a failed tool call. */
const isRetryableStatus = (status: number): boolean =>
  status >= 500 || status === 429 || status === 408;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getJson<T = unknown>(
  source: string,
  url: string,
  opts: FetchOpts = {},
): Promise<T> {
  const { timeoutMs = 30_000, retry = true } = opts;
  const attempts = retry ? 3 : 1;
  let lastErr: unknown;
  let lastStatus = 0;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Counted per ATTEMPT, not per call: OpenAlex meters what actually reaches
    // it, so a retried request that was counted once under-reported the traffic
    // this counter exists to price.
    CALLS.set(source, (CALLS.get(source) ?? 0) + 1);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', 'user-agent': UA },
      });
      if (!res.ok) throw new SourceError(source, res.status, `${res.status} on ${redact(url)}`);
      try {
        return (await res.json()) as T;
      } catch {
        // A 200 carrying an HTML holding page (a proxy, a maintenance splash).
        // Reported as what it is rather than as a parser message, and NOT
        // retried: the body will parse the same way next time.
        throw new SourceError(
          source,
          res.status,
          `${res.status} on ${redact(url)} returned a non-JSON body`,
        );
      }
    } catch (err) {
      lastErr = err;
      if (err instanceof SourceError) {
        lastStatus = err.status;
        // A 4xx other than 429/408 is the server telling you the request was
        // wrong; asking twice gets the same answer and spends someone else's
        // quota.
        if (!isRetryableStatus(err.status)) throw err;
      }
      // Backoff with jitter. Reissuing instantly is the traffic pattern that
      // gets a shared pool to block you — the thing the batching in
      // corrections.ts already goes out of its way to avoid.
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }
  // Carry the real upstream status through. Reporting 0 for a clean 503 hid
  // which source was actually degraded from every log and every error string.
  throw new SourceError(
    source,
    lastStatus,
    lastErr instanceof Error ? lastErr.message : 'unreachable',
  );
}

/** the query string is the only part of these URLs worth reading in a log */
function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

export const qs = (params: Record<string, string | number | undefined>): string =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
