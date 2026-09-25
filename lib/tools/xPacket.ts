/**
 * lib/tools/xPacket.ts — a deterministic X "chatter packet" for a list of
 * cashtags: how loud each one is today against its own recent days, and the
 * top posts for the ones that are unusually loud. No model runs here.
 *
 * WHY this exists: a daily news desk that searched X itself (a fuzzy ranker,
 * billed inside its own context) could not tell a quiet name from a search
 * that found nothing, and paid for that inside a 170K–250K-token call. Code
 * can ask X the countable question — how many posts carry $SYM — and read
 * posts only where the count says something happened. The caller (an
 * operator pipeline, over `POST /v1/x-packet`) hands the packet to its desk
 * as input. A name with 0 posts is a measured silence.
 *
 * SHAPE of one call (per cashtag):
 *   1. GET /2/tweets/counts/recent, hourly, the full 7-day window. The last
 *      24h is `count`; the median of the five 24h windows before it is
 *      `baseline` (a median, so two weekend days in five cannot drag it).
 *   2. `unusual` when count ≥ minPosts AND count/baseline ≥ spikeRatio.
 *   3. For at most maxNames unusual names (loudest ratio first): one page of
 *      /2/tweets/search/recent over the last 24h, ranked by engagement,
 *      trusted handles first, top `topPosts` kept.
 *
 * COST: post reads bill at PRICE.postRead each (xApiSearchTool.ts); only
 * step 3 reads posts, so a quiet day reads none. Count calls return counts,
 * not posts. Env dials: X_PACKET_SPIKE_RATIO (2.0), X_PACKET_MIN_POSTS (30),
 * X_PACKET_MAX_NAMES (5), X_PACKET_POSTS_READ (20, 10–100),
 * X_PACKET_TOP_POSTS (4), X_PACKET_TRUSTED_HANDLES (comma list).
 *
 * Images are not transcribed here: the packet is input to another model,
 * and every transcribed picture is one more untrusted text in its prompt.
 */

import { FIELDS, PRICE, parseSearchJson, xApiToken } from './xApiSearchTool.ts';
import type { XPost } from './xApiSearchTool.ts';

const API = 'https://api.x.com/2';
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const FETCH_TIMEOUT_MS = 8_000;
/** Whole-packet budget: the route must answer inside Heroku's 30s router
 *  timeout, so a name not started by then carries an error instead. */
const BUDGET_MS = 22_000;
const CONCURRENCY = 5;
const MAX_TICKERS = 60;
const BASELINE_DAYS = 5;
const MAX_POST_CHARS = 500;

/** Cashtag-shaped symbols only (BRK.B → $BRK.B is what X indexes). */
const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

export interface XPacketDeps {
  fetch: typeof fetch;
  now: () => number;
  env: NodeJS.ProcessEnv;
}

export interface PacketPost {
  handle: string;
  name: string;
  verified: boolean;
  trusted: boolean;
  created_at: string;
  text: string;
  likes: number;
  reposts: number;
  replies: number;
  views: number;
  url: string;
}

export interface PacketTicker {
  symbol: string;
  count?: number;
  baseline?: number;
  ratio?: number;
  unusual?: boolean;
  posts?: PacketPost[];
  error?: string;
}

export interface XPacket {
  generated_at: string;
  window_hours: 24;
  baseline_days: number;
  spike_ratio: number;
  min_posts: number;
  tickers: PacketTicker[];
  unusual: string[];
  posts_read: number;
  est_cost_usd: number;
}

export interface PacketDials {
  spikeRatio: number;
  minPosts: number;
  maxNames: number;
  postsRead: number;
  topPosts: number;
  trusted: Set<string>;
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, lo: number, hi: number): number {
  const n = Number(env[name]?.trim());
  return Number.isFinite(n) && env[name]?.trim() ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export function packetDials(env: NodeJS.ProcessEnv = process.env): PacketDials {
  return {
    spikeRatio: num(env, 'X_PACKET_SPIKE_RATIO', 2.0, 1.1, 20),
    minPosts: Math.round(num(env, 'X_PACKET_MIN_POSTS', 30, 1, 100_000)),
    maxNames: Math.round(num(env, 'X_PACKET_MAX_NAMES', 5, 0, 20)),
    postsRead: Math.round(num(env, 'X_PACKET_POSTS_READ', 20, 10, 100)),
    topPosts: Math.round(num(env, 'X_PACKET_TOP_POSTS', 4, 1, 10)),
    trusted: new Set(
      (env.X_PACKET_TRUSTED_HANDLES ?? '')
        .split(',')
        .map((h) => h.trim().replace(/^@/, '').toLowerCase())
        .filter(Boolean),
    ),
  };
}

/** Request tickers → the unique valid symbols, capped. Invalid ones are
 *  returned apart so the caller can say which were refused. */
export function normalizeTickers(raw: unknown): { ok: string[]; refused: string[] } {
  const ok: string[] = [];
  const refused: string[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    const s = String(t ?? '').trim().toUpperCase();
    if (TICKER_RE.test(s)) {
      if (!ok.includes(s)) ok.push(s);
    } else if (s) refused.push(s.slice(0, 16));
  }
  return { ok: ok.slice(0, MAX_TICKERS), refused };
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hourly count buckets → {count, baseline, ratio}. Pure. A bucket belongs to
 *  the 24h window its START falls in, measured back from `now`. */
export function volumeFromCounts(
  buckets: Array<{ start: string; tweet_count: number }>,
  now: number,
): { count: number; baseline: number; ratio: number } {
  const windows = new Array(BASELINE_DAYS + 1).fill(0);
  for (const b of buckets) {
    const age = now - Date.parse(b.start);
    if (!Number.isFinite(age) || age < 0) continue;
    const w = Math.floor(age / DAY_MS);
    if (w < windows.length) windows[w] += Number(b.tweet_count) || 0;
  }
  const count = windows[0];
  const baseline = median(windows.slice(1));
  const ratio = count / Math.max(1, baseline);
  return { count, baseline, ratio: Math.round(ratio * 100) / 100 };
}

/** Engagement rank: trusted handles first, then likes + 2×reposts. Pure. */
export function rankPosts(posts: XPost[], trusted: Set<string>, top: number): PacketPost[] {
  return posts
    .map((p) => ({
      handle: p.handle ?? '',
      name: p.name ?? '',
      verified: p.authorVerified === true,
      trusted: !!p.handle && trusted.has(p.handle.toLowerCase()),
      created_at: p.createdAt,
      text: p.text.length > MAX_POST_CHARS ? `${p.text.slice(0, MAX_POST_CHARS)}…` : p.text,
      likes: p.metrics?.likes ?? 0,
      reposts: p.metrics?.reposts ?? 0,
      replies: p.metrics?.replies ?? 0,
      views: p.metrics?.views ?? 0,
      url: p.url ?? '',
    }))
    .sort(
      (a, b) =>
        Number(b.trusted) - Number(a.trusted) || b.likes + 2 * b.reposts - (a.likes + 2 * a.reposts),
    )
    .slice(0, top);
}

async function getJson(url: URL, token: string, deps: XPacketDeps, deadline: number): Promise<any> {
  const left = deadline - deps.now();
  if (left <= 0) throw new Error('time budget spent');
  const res = await deps.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, left)),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json()).slice(0, 200);
    } catch { /* not JSON */ }
    throw new Error(`HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json();
}

async function countsFor(sym: string, token: string, deps: XPacketDeps, deadline: number) {
  const now = deps.now();
  const url = new URL(`${API}/tweets/counts/recent`);
  url.searchParams.set('query', `$${sym} -is:retweet lang:en`);
  url.searchParams.set('granularity', 'hour');
  // The window must sit inside the last 7 days; a minute's margin each end.
  url.searchParams.set('start_time', iso(now - 7 * DAY_MS + 60_000));
  url.searchParams.set('end_time', iso(now - 30_000));
  const json = await getJson(url, token, deps, deadline);
  return volumeFromCounts(Array.isArray(json?.data) ? json.data : [], now);
}

async function postsFor(sym: string, token: string, deps: XPacketDeps, dials: PacketDials, deadline: number) {
  const now = deps.now();
  const url = new URL(`${API}/tweets/search/recent`);
  url.searchParams.set('query', `$${sym} -is:retweet -is:reply lang:en`);
  url.searchParams.set('start_time', iso(now - DAY_MS));
  url.searchParams.set('end_time', iso(now - 30_000));
  url.searchParams.set('max_results', String(dials.postsRead));
  url.searchParams.set('sort_order', 'relevancy');
  for (const [k, v] of Object.entries(FIELDS)) url.searchParams.set(k, v);
  const posts = parseSearchJson(await getJson(url, token, deps, deadline));
  return { read: posts.length, top: rankPosts(posts, dials.trusted, dials.topPosts) };
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const DEFAULT_DEPS: XPacketDeps = { fetch: (...a) => fetch(...a), now: () => Date.now(), env: process.env };

/**
 * Build the packet. Never throws for a per-name failure (that name carries
 * `error`); throws only when there is no token, which the route maps to 503.
 */
export async function buildXPacket(symbols: string[], deps: XPacketDeps = DEFAULT_DEPS): Promise<XPacket> {
  const token = xApiToken(deps.env);
  if (!token) throw new Error('X_BEARER_TOKEN is not set on this server');
  const dials = packetDials(deps.env);
  const deadline = deps.now() + BUDGET_MS;

  const tickers: PacketTicker[] = await pool(symbols, CONCURRENCY, async (symbol) => {
    try {
      const v = await countsFor(symbol, token, deps, deadline);
      return { symbol, ...v, unusual: v.count >= dials.minPosts && v.ratio >= dials.spikeRatio };
    } catch (err) {
      return { symbol, error: String((err as Error).message ?? err).slice(0, 200) };
    }
  });

  const loud = tickers
    .filter((t) => t.unusual)
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))
    .slice(0, dials.maxNames);
  let postsRead = 0;
  await pool(loud, CONCURRENCY, async (t) => {
    try {
      const { read, top } = await postsFor(t.symbol, token, deps, dials, deadline);
      postsRead += read;
      t.posts = top;
    } catch (err) {
      t.posts = [];
      console.warn(`[x_packet] ${t.symbol} posts failed: ${(err as Error).message ?? err}`);
    }
  });

  const packet: XPacket = {
    generated_at: iso(deps.now()),
    window_hours: 24,
    baseline_days: BASELINE_DAYS,
    spike_ratio: dials.spikeRatio,
    min_posts: dials.minPosts,
    tickers,
    unusual: tickers.filter((t) => t.unusual).map((t) => t.symbol),
    posts_read: postsRead,
    est_cost_usd: Math.round(postsRead * PRICE.postRead * 1000) / 1000,
  };
  const failed = tickers.filter((t) => t.error).length;
  console.log(
    `[x_packet] ${symbols.length} cashtag(s) counted${failed ? ` (${failed} failed)` : ''}; ` +
      `unusual: ${packet.unusual.join(', ') || 'none'}; ${postsRead} post(s) read (≈$${packet.est_cost_usd.toFixed(3)})`,
  );
  return packet;
}
