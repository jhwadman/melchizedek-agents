/**
 * lib/models/retry.ts — the one retry policy for transient provider failures.
 *
 * WHY this file exists:
 *   Before it, resilience was an accident of which SDK an adapter used.
 *   Claude and GPT/Grok inherited their vendor SDKs' two retries; Gemini —
 *   the default provider — got none (`@google/genai` does a single fetch
 *   unless retryOptions is set, and ADK's Gemini never sets it); the
 *   chat-completions path (Ollama, gateways) was one bare `fetch`. A 503
 *   "high demand" from Google failed the whole turn. One policy here, used by
 *   every adapter that does not get it from its SDK, keeps the behaviour the
 *   same whichever provider an agent's YAML names.
 *
 * THE POLICY:
 *   - Bounded: MODEL_RETRY_MAX_ATTEMPTS total attempts (default 3, clamped
 *     1..10; 1 disables retries). Matches the vendor SDKs' 1 + 2 retries.
 *   - Retried: HTTP 408/409/425/429/500/502/503/504, and connection-level
 *     failures that say nothing about the request (ECONNRESET, ETIMEDOUT,
 *     EPIPE, ECONNABORTED, EAI_AGAIN, undici socket/connect-timeout). Every
 *     other 4xx is the request's own fault and is never repeated.
 *   - NOT retried: ECONNREFUSED / ENOTFOUND. Against Ollama on localhost a
 *     refused connection means the server is not running, and the adapter's
 *     own message already says how to start it; retrying only delays that
 *     diagnosis by seconds, and no daemon restarts inside our backoff window.
 *     Against a remote gateway it means a wrong host or port — configuration,
 *     not load. Response-wait timeouts (undici headers/body timeout) are not
 *     retried either: a request that already ran for minutes is better
 *     reported than repeated at the same cost.
 *   - Backoff: full jitter, uniform in [0, min(8 s, 500 ms * 2^(n-1))], so
 *     callers that failed together do not come back together.
 *   - Retry-After (seconds, HTTP date, or OpenAI's retry-after-ms; Google's
 *     RetryInfo `retryDelay` in an error body) replaces the jittered delay
 *     when present. Above 60 s the call is NOT retried at all: per-minute
 *     quota windows reset inside a minute, so a longer wait signals a daily
 *     or hard quota that waiting will not fix — surface it now.
 *   - Cancellation: the turn's AbortSignal (lib/runtime/turnControl.ts) is
 *     checked before every retry and wakes the backoff sleep, so a canceled
 *     or timed-out turn never sleeps past its abort and never re-sends.
 *
 * THE STREAMING RULE:
 *   A retry is only ever made BEFORE the caller has received any response
 *   bytes. A failure after the first partial has been yielded would, if
 *   retried, replay text the user has already seen (and that ADK may have
 *   already turned into events). `fetchWithRetry` retries the request and
 *   hands back the Response before its body is read; `retryUntilFirstYield`
 *   retries a generator only while it has yielded nothing.
 *
 * Retries run inside one `llm.request` span and one step-budget charge: a
 * retried call is still one logical model call. The count lands on the span
 * as `llm.retries` (via the onRetry hook each adapter wires to
 * setLlmSpanAttribute).
 */

export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
  408, 409, 425, 429, 500, 502, 503, 504,
]);

export const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export interface RetryPolicy {
  /** Total attempts including the first; 1 = no retries. */
  maxAttempts: number;
  /** Backoff ceiling for attempt 1; doubles per attempt. */
  baseDelayMs: number;
  /** Backoff ceiling never grows past this. */
  maxDelayMs: number;
  /** A Retry-After longer than this is not waited out — the call fails. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
});

export const MAX_ATTEMPTS_ENV = 'MODEL_RETRY_MAX_ATTEMPTS';

let overrides: Partial<RetryPolicy> = {};

/**
 * Process-wide overrides for the policy (tests shrink the delays; an
 * embedding app can tune them). Returns a function restoring the previous
 * overrides. The env var still sets maxAttempts unless overridden here.
 */
export function setRetryPolicyOverrides(next: Partial<RetryPolicy>): () => void {
  const previous = overrides;
  overrides = { ...next };
  return () => {
    overrides = previous;
  };
}

/** The effective policy: defaults ← MODEL_RETRY_MAX_ATTEMPTS ← overrides. */
export function retryPolicy(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const raw = Number.parseInt(env[MAX_ATTEMPTS_ENV] ?? '', 10);
  const fromEnv = Number.isFinite(raw) ? Math.min(10, Math.max(1, raw)) : undefined;
  return {
    ...DEFAULT_RETRY_POLICY,
    ...(fromEnv !== undefined ? { maxAttempts: fromEnv } : {}),
    ...overrides,
  };
}

// ── Classification ───────────────────────────────────────────────────────────

/** What one failed attempt says about trying again. */
export interface RetryDecision {
  retryable: boolean;
  /** HTTP status, when the failure had one. */
  status?: number;
  /** Server-requested wait, when it sent one. */
  retryAfterMs?: number;
}

export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status);
}

/** The system/undici error code anywhere on an error's cause chain. */
export function networkErrorCode(err: unknown): string | undefined {
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (typeof cur.code === 'string') return cur.code;
    cur = cur.cause;
  }
  return undefined;
}

/** A numeric HTTP status carried on an error (genai ApiError, SDK errors). */
export function errorStatus(err: unknown): number | undefined {
  const s = (err as any)?.status;
  return typeof s === 'number' && s >= 100 && s < 600 ? s : undefined;
}

/** Classifies a non-2xx HTTP response. */
export function classifyResponse(res: Pick<Response, 'status' | 'headers'>): RetryDecision {
  return {
    retryable: isRetryableStatus(res.status),
    status: res.status,
    retryAfterMs: retryAfterFromHeaders(res.headers),
  };
}

/** Classifies a thrown error (an HTTP error from an SDK, or a network one). */
export function classifyError(err: unknown): RetryDecision {
  const status = errorStatus(err);
  if (status !== undefined) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      retryable: isRetryableStatus(status),
      status,
      retryAfterMs: googleRetryDelayMs(message),
    };
  }
  const code = networkErrorCode(err);
  return { retryable: code !== undefined && RETRYABLE_NETWORK_CODES.has(code) };
}

// ── Retry-After ──────────────────────────────────────────────────────────────

/**
 * Parses a Retry-After value: delta-seconds ("30", "1.5") or an HTTP date.
 * Returns milliseconds (never negative), or undefined when unparseable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (!v) return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/** Retry-After from response headers, preferring OpenAI's retry-after-ms. */
export function retryAfterFromHeaders(
  headers: Pick<Headers, 'get'> | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const ms = Number(headers.get('retry-after-ms'));
  if (headers.get('retry-after-ms') && Number.isFinite(ms) && ms >= 0) return ms;
  return parseRetryAfter(headers.get('retry-after'), now);
}

/**
 * Google RPC's RetryInfo, which genai only exposes inside the error message
 * (its ApiError drops the response headers): `"retryDelay": "37s"`.
 */
export function googleRetryDelayMs(message: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

// ── Scheduling ───────────────────────────────────────────────────────────────

/** Full-jitter backoff for the given (1-based) failed attempt. */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy = retryPolicy(),
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

/**
 * How long to wait before attempt `attempt + 1`, or undefined to stop:
 * not retryable, attempts exhausted, the turn aborted, or the server asked
 * for a wait beyond the cap.
 */
export function nextRetryDelay(
  attempt: number,
  decision: RetryDecision,
  policy: RetryPolicy = retryPolicy(),
  signal?: AbortSignal,
  random: () => number = Math.random,
): number | undefined {
  if (signal?.aborted) return undefined;
  if (!decision.retryable) return undefined;
  if (attempt >= policy.maxAttempts) return undefined;
  if (decision.retryAfterMs !== undefined) {
    return decision.retryAfterMs > policy.maxRetryAfterMs ? undefined : decision.retryAfterMs;
  }
  return backoffDelayMs(attempt, policy, random);
}

/**
 * Sleeps `ms`, waking early if `signal` aborts. Resolves true when the full
 * wait elapsed, false when it was cut short by an abort.
 */
export function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface RetryOptions {
  signal?: AbortSignal;
  policy?: RetryPolicy;
  /** Called before each wait; `retries` counts retries made so far + 1. */
  onRetry?: (info: { retries: number; delayMs: number; decision: RetryDecision }) => void;
  /** Injectable for tests. */
  random?: () => number;
}

// ── fetch ────────────────────────────────────────────────────────────────────

/**
 * `fetch` with the policy applied to the REQUEST. Returns the first 2xx, or
 * the last non-2xx Response once retrying stops (body unread, so the caller
 * builds its own error from it). Throws the last error when the final
 * attempt failed at the network level. The body of a successful response is
 * never touched here — reading (and streaming) it is the caller's, and a
 * failure there is not retried (see THE STREAMING RULE above).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<{ response: Response; retries: number }> {
  const policy = opts.policy ?? retryPolicy();
  const signal = opts.signal ?? (init.signal as AbortSignal | undefined) ?? undefined;
  let retries = 0;
  for (let attempt = 1; ; attempt++) {
    let decision: RetryDecision;
    let response: Response | undefined;
    try {
      response = await fetch(url, init);
      if (response.ok) return { response, retries };
      decision = classifyResponse(response);
    } catch (err) {
      decision = classifyError(err);
      const delay = nextRetryDelay(attempt, decision, policy, signal, opts.random);
      if (delay === undefined) throw err;
      retries++;
      opts.onRetry?.({ retries, delayMs: delay, decision });
      if (!(await sleepUnlessAborted(delay, signal))) throw err;
      continue;
    }
    const delay = nextRetryDelay(attempt, decision, policy, signal, opts.random);
    if (delay === undefined) return { response, retries };
    // Release the connection: an unread body pins its socket.
    await response.body?.cancel().catch(() => {});
    retries++;
    opts.onRetry?.({ retries, delayMs: delay, decision });
    if (!(await sleepUnlessAborted(delay, signal))) {
      // Aborted mid-wait: the last real outcome is the honest one to report,
      // but its body is gone — hand back a bodiless copy of the status.
      return {
        response: new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }),
        retries,
      };
    }
  }
}

// ── generators ───────────────────────────────────────────────────────────────

/**
 * Re-runs a generator factory while it fails BEFORE its first yield. Once
 * anything has been yielded a failure is rethrown untouched: retrying then
 * would duplicate output the caller has already passed on.
 */
export async function* retryUntilFirstYield<T>(
  start: (attempt: number) => AsyncGenerator<T, void>,
  opts: RetryOptions = {},
): AsyncGenerator<T, void> {
  const policy = opts.policy ?? retryPolicy();
  let retries = 0;
  for (let attempt = 1; ; attempt++) {
    let yielded = false;
    try {
      for await (const item of start(attempt)) {
        yielded = true;
        yield item;
      }
      return;
    } catch (err) {
      if (yielded) throw err;
      const decision = classifyError(err);
      const delay = nextRetryDelay(attempt, decision, policy, opts.signal, opts.random);
      if (delay === undefined) throw annotate(err, decision, retries);
      retries++;
      opts.onRetry?.({ retries, delayMs: delay, decision });
      if (!(await sleepUnlessAborted(delay, opts.signal))) throw annotate(err, decision, retries);
    }
  }
}

/** Marks a surfaced error with what the policy concluded, for callers above. */
function annotate(err: unknown, decision: RetryDecision, retries: number): unknown {
  if (err && typeof err === 'object') {
    try {
      Object.assign(err, { retryable: decision.retryable, retries });
    } catch {
      /* a frozen error is still the right error to throw */
    }
  }
  return err;
}
