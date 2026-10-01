/**
 * lib/tools/webExtractTool.ts — deterministic URL → clean-text reading.
 *
 * WHY this file exists:
 *   `web_search` routes to each provider's SERVER-SIDE search (§7.5): the
 *   provider decides which pages to fetch and which snippets to quote. An
 *   agent could never say "now read THIS article in full" — for a news
 *   agent that is the difference between arbitrating what a search chose
 *   to quote and actually reading the five articles being compared.
 *   `web_extract` closes that gap: a plain client-side function tool that
 *   fetches given URLs and returns the page's clean text. Deterministic,
 *   no LLM summarization, and KEYLESS — it also works on local Ollama
 *   agents, the first web capability local mode gets.
 *
 * DESIGN (cribbed from NousResearch/hermes-agent `web_extract`, adapted):
 *   - Up to 5 URLs per call; per-page character budget (default 15k,
 *     WEB_EXTRACT_CHAR_LIMIT env, clamped 2k–500k — deployment config,
 *     never YAML, the XAI_COLLECTION_IDS doctrine).
 *   - Over-budget pages return a head+tail window (~75%/25%) with an
 *     omission marker. Hermes spills full text to disk and tells the
 *     agent to page with read_file; melchizedek agents have no filesystem
 *     tools, so paging is an `offset` param instead: the full text is
 *     held in a 15-minute in-process cache and re-calling with
 *     `{urls:[same], offset:N}` continues reading without refetching.
 *   - Zero new dependencies: native fetch + a heuristic HTML→markdown
 *     pipeline (strip script/style/nav chrome, prefer <article>/<main>,
 *     headings/lists/links/blockquotes to markdown, entities decoded,
 *     base64 images never survive because <img> collapses to alt text).
 *
 * SECURITY (SSRF):
 *   Agents pass arbitrary URLs and this process may run server-side, so
 *   http(s) only, and every hop (redirects are followed manually) passes
 *   lib/net/addressGuard.ts: local names and non-public IP literals in
 *   every encoding are refused, and names are resolved and refused when
 *   any address they resolve to is non-public. The remaining limit (DNS
 *   rebinding between check and connect) is stated in that module.
 *
 * FAILURE CONTRACT: never throws. Each URL yields either its content
 *   block or an inline `Error:` block; one bad URL never sinks the rest.
 */

import { z } from 'zod';

import { checkHost } from '../net/addressGuard.ts';
import { defineTool, toFunctionTool } from './toolContract.ts';

export const WEB_EXTRACT_TOOL_NAME = 'web_extract';

const MAX_URLS = 5;
const DEFAULT_CHAR_LIMIT = 15_000;
const MIN_CHAR_LIMIT = 2_000;
const MAX_CHAR_LIMIT = 500_000;
const HEAD_FRACTION = 0.75;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_FETCH_BYTES = 5 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 50;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 melchizedek-web-extract';

/** Per-page char budget from the environment; malformed values warn and fall back. */
export function extractCharLimit(): number {
  const raw = process.env.WEB_EXTRACT_CHAR_LIMIT?.trim();
  if (!raw) return DEFAULT_CHAR_LIMIT;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.warn(`[web_extract] WEB_EXTRACT_CHAR_LIMIT="${raw}" is not a number — using ${DEFAULT_CHAR_LIMIT}.`);
    return DEFAULT_CHAR_LIMIT;
  }
  return Math.max(MIN_CHAR_LIMIT, Math.min(Math.floor(value), MAX_CHAR_LIMIT));
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
// Re-exported: lib/net/addressGuard.ts is the one implementation.
export { blockedHostReason } from '../net/addressGuard.ts';

// ── HTML → markdown-ish text (zero-dep heuristic) ───────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', times: '×', deg: '°',
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function safeCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** Inline content of a captured tag body: tags out, entities decoded, whitespace collapsed. */
function inlineText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Remove every `<tag ...>...</tag>` block (non-greedy — nested same-name tags mis-slice, acceptable heuristic). */
function stripBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const tag of tags) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  return out;
}

export interface ExtractedPage {
  title: string | null;
  text: string;
  /**
   * Where the fetch landed, when redirects moved it off the requested URL.
   * A search engine hands out redirect links (Gemini grounding, for one), and
   * a note that cites the redirect instead of the publisher cannot be checked.
   */
  finalUrl?: string;
}

export function extractHtml(html: string): ExtractedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? inlineText(titleMatch[1]) || null : null;

  let doc = html.replace(/<!--[\s\S]*?-->/g, ' ');
  doc = stripBlocks(doc, ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'head']);

  // Prefer the semantic article/main region; fall back to <body>, then the whole doc.
  const region =
    longestMatch(doc, /<article\b[^>]*>[\s\S]*?<\/article>/gi) ??
    longestMatch(doc, /<main\b[^>]*>[\s\S]*?<\/main>/gi) ??
    longestMatch(doc, /<body\b[^>]*>[\s\S]*?<\/body>/gi) ??
    doc;

  let text = stripBlocks(region, ['nav', 'header', 'footer', 'aside', 'form', 'button', 'select', 'dialog']);

  // Structure → markdown. Headings first (they consume their own bodies).
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const line = inlineText(body);
    return line ? `\n\n${'#'.repeat(Number(level))} ${line}\n\n` : '\n\n';
  });
  // Links: keep absolute http(s) targets as markdown; relative links keep text only.
  text = text.replace(
    /<a\b[^>]*href=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, body) => {
      const label = inlineText(body);
      if (!label) return ' ';
      return label === href ? ` ${href} ` : ` [${label}](${href}) `;
    },
  );
  // Images collapse to alt text — base64 payloads and trackers never reach the model.
  text = text.replace(/<img\b[^>]*>/gi, (tag) => {
    const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1]?.trim();
    return alt ? ` [IMAGE: ${decodeEntities(alt)}] ` : ' ';
  });
  text = text
    .replace(/<blockquote\b[^>]*>/gi, '\n\n> ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|figure|pre)>/gi, '\n')
    .replace(/<p\b[^>]*>/gi, '\n\n');

  text = decodeEntities(text.replace(/<[^>]+>/g, ' '));
  text = text
    .replace(/\r/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text };
}

// ── Block-page detection ────────────────────────────────────────────────────
//
// The dangerous failure class is 200-with-garbage: Cloudflare challenges,
// consent walls, "enable JavaScript" shells, and paywall stubs all return
// HTTP 200 with real HTML, and the extractor would hand their boilerplate
// to the model AS IF it were the article. Detection is deterministic and
// lives here, not in agent prompts — a model judging "is this a real
// article?" fails silently one time in ten; a signature scan doesn't.
// Detected blocks collapse into the same labeled `Error:` shape as an
// HTTP 403, so prompts only ever govern the RESPONSE to a known failure.
//
// False-positive guards: signature scans only run on SHORT extractions
// (a real article quoting "just a moment" is long); paywall phrasing is
// held to a tighter threshold than bot-check phrasing because it also
// appears in the footers of readable articles.

/** Extraction lengths at or below these invite the corresponding scan. */
const BOT_CHECK_SCAN_MAX_CHARS = 2_000;
const PAYWALL_SCAN_MAX_CHARS = 1_500;
/** A big HTML document that extracts to almost nothing is a JS shell. */
const THIN_TEXT_CHARS = 400;
const THIN_HTML_MIN_BYTES = 20_000;

const BOT_CHECK_SIGNATURES: Array<[RegExp, string]> = [
  [/just a moment/i, 'Cloudflare challenge'],
  [/checking your browser before accessing/i, 'Cloudflare challenge'],
  [/verify(?:ing)? (?:that )?you are (?:a )?human/i, 'bot check'],
  [/enable javascript and cookies to continue/i, 'bot check'],
  [/are you a robot/i, 'bot check'],
  [/access to this page has been denied/i, 'access-denied page'],
  [/pardon our interruption/i, 'bot check'],
];

const PAYWALL_SIGNATURES: Array<[RegExp, string]> = [
  [/subscribe to (?:read|continue)/i, 'paywall'],
  [/subscription (?:is )?required/i, 'paywall'],
  [/to continue reading(?:,| this)/i, 'paywall'],
  [/create a free account to (?:read|continue)/i, 'registration wall'],
  [/log in to (?:read|continue)/i, 'registration wall'],
];

/**
 * Reason the extraction looks like a block page rather than content, or
 * null when it looks legitimate. `htmlBytes` is the raw document size —
 * the thinness check needs it to tell "big page, no text" (a JS shell)
 * from a genuinely small page, which stays valid.
 */
export function blockedPageReason(text: string, htmlBytes: number): string | null {
  if (text.length <= BOT_CHECK_SCAN_MAX_CHARS) {
    for (const [pattern, label] of BOT_CHECK_SIGNATURES) {
      const hit = text.match(pattern);
      if (hit) return `page is a ${label} (detected: "${hit[0]}") — content unavailable`;
    }
  }
  if (text.length <= PAYWALL_SCAN_MAX_CHARS) {
    for (const [pattern, label] of PAYWALL_SIGNATURES) {
      const hit = text.match(pattern);
      if (hit) return `page is behind a ${label} (detected: "${hit[0]}") — content unavailable`;
    }
  }
  if (htmlBytes >= THIN_HTML_MIN_BYTES && text.length < THIN_TEXT_CHARS) {
    return (
      `page yielded almost no text (${text.length} chars from ${htmlBytes} bytes of HTML) — ` +
      'likely requires JavaScript or blocks automated readers'
    );
  }
  return null;
}

function longestMatch(html: string, pattern: RegExp): string | null {
  let best: string | null = null;
  for (const match of html.match(pattern) ?? []) {
    if (best === null || match.length > best.length) best = match;
  }
  return best;
}

// ── Windowing (budget + paging) ─────────────────────────────────────────────

/** Continuation hint rendered into omission markers — the agent copies it verbatim. */
function continueCall(url: string, offset: number): string {
  return `web_extract({"urls":["${url}"],"offset":${offset}})`;
}

export function windowContent(text: string, url: string, limit: number, offset?: number): string {
  const total = text.length;
  if (offset !== undefined) {
    if (offset >= total) {
      return `[offset ${offset} is past the end — the cached page is ${total} chars long]`;
    }
    const end = Math.min(offset + limit, total);
    const slice = text.slice(offset, end);
    const head = `[resuming at char ${offset} of ${total}]\n\n`;
    const foot =
      end < total
        ? `\n\n[... ${total - end} chars remain — ${continueCall(url, end)} to continue ...]`
        : '';
    return head + slice + foot;
  }
  if (total <= limit) return text;
  const headLen = Math.floor(limit * HEAD_FRACTION);
  const tailLen = limit - headLen;
  const omittedFrom = headLen;
  const omittedTo = total - tailLen;
  return (
    text.slice(0, headLen) +
    `\n\n[... chars ${omittedFrom}–${omittedTo} of ${total} omitted — ` +
    `${continueCall(url, omittedFrom)} to continue reading ...]\n\n` +
    text.slice(omittedTo)
  );
}

// ── Fetch + cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  page: ExtractedPage;
  fetchedAt: number;
}

const pageCache = new Map<string, CacheEntry>();

/** Test hook — the cache is process-global. */
export function clearWebExtractCache(): void {
  pageCache.clear();
}

function cachedPage(url: string): ExtractedPage | null {
  const entry = pageCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    pageCache.delete(url);
    return null;
  }
  return entry.page;
}

function cachePage(url: string, page: ExtractedPage): void {
  while (pageCache.size >= CACHE_MAX_ENTRIES) {
    const oldest = pageCache.keys().next().value;
    if (oldest === undefined) break;
    pageCache.delete(oldest);
  }
  pageCache.set(url, { page, fetchedAt: Date.now() });
}

/** Validate scheme + host (resolving it); returns an error string or the parsed URL. */
async function checkUrl(raw: string): Promise<URL | string> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `Error: "${raw}" is not a valid absolute URL.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: only http(s) URLs are supported (got ${parsed.protocol}//).`;
  }
  const blocked = await checkHost(parsed.hostname);
  if (blocked) return `Error: refusing to fetch ${parsed.hostname} (${blocked}).`;
  return parsed;
}

/** Read the body with a hard byte cap so a huge response can't balloon memory. */
async function readBodyCapped(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_FETCH_BYTES) {
      chunks.push(value.subarray(0, value.byteLength - (received - MAX_FETCH_BYTES)));
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const decoder = new TextDecoder('utf-8'); // charset sniffing deliberately skipped
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

/** Fetch with manual redirect following so every hop passes the SSRF guard. */
async function fetchPage(url: URL): Promise<ExtractedPage | string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: fetch failed (${msg}).`;
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) return `Error: HTTP ${res.status} redirect with no Location header.`;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return `Error: redirect to unparseable URL "${location}".`;
      }
      const checked = await checkUrl(next.toString());
      if (typeof checked === 'string') return checked;
      current = checked;
      continue;
    }
    if (!res.ok) return `Error: HTTP ${res.status} ${res.statusText || ''}`.trim() + '.';

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('application/pdf')) {
      return 'Error: PDF extraction is not supported (keyless v1 reads HTML/text only).';
    }
    const isHtml = contentType.includes('html') || contentType === '';
    const isText =
      contentType.startsWith('text/') ||
      contentType.includes('json') ||
      contentType.includes('xml');
    if (!isHtml && !isText) {
      return `Error: unsupported content-type "${contentType}".`;
    }
    const body = await readBodyCapped(res);
    const moved = current.toString() !== url.toString() ? { finalUrl: current.toString() } : {};
    if (!isHtml) return { title: null, text: body.trim(), ...moved };
    const page = { ...extractHtml(body), ...moved };
    // Block pages are errors, not content — and deliberately NOT cached,
    // so a later run against a recovered site fetches fresh.
    const blocked = blockedPageReason(page.text, body.length);
    if (blocked) return `Error: ${blocked}`;
    return page;
  }
  return `Error: more than ${MAX_REDIRECTS} redirects.`;
}

// ── The contract ────────────────────────────────────────────────────────────

export const webExtractContract = defineTool({
  name: WEB_EXTRACT_TOOL_NAME,
  description:
    'Read web pages in full. Fetches each URL directly and returns the clean page text ' +
    '(markdown-ish, no summarization) — use it after web_search, or with any known URL, ' +
    'to read an article beyond its headline or snippet. Long pages return a head+tail ' +
    'window with an omission marker; to keep reading, call again with a SINGLE url and ' +
    'the `offset` from the marker. Up to 5 URLs per call. HTML and plain text only (no PDFs). ' +
    'When a URL redirected, a "Resolved:" line gives the page it landed on: cite that URL, not the redirect.',
  schema: z.object({
    urls: z
      .array(z.string())
      .min(1)
      .max(MAX_URLS)
      .describe(`Absolute http(s) URLs to read (1–${MAX_URLS}).`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Character offset to resume reading a previously truncated page from. ' +
          'Only valid with exactly one url; copy the value from the omission marker.',
      ),
  }),
  execute: async ({ urls, offset }) => {
    if (offset !== undefined && urls.length !== 1) {
      return 'Error: `offset` is only valid with exactly one url.';
    }
    const limit = extractCharLimit();
    const blocks = await Promise.all(
      urls.map(async (raw) => {
        const checked = await checkUrl(raw.trim());
        if (typeof checked === 'string') return `=== ${raw} ===\n${checked}`;
        const url = checked.toString();
        let page = cachedPage(url);
        if (!page) {
          const fetched = await fetchPage(checked);
          if (typeof fetched === 'string') return `=== ${url} ===\n${fetched}`;
          page = fetched;
          cachePage(url, page);
        }
        if (!page.text) return `=== ${url} ===\nError: page yielded no readable text.`;
        const resolved = page.finalUrl ? `Resolved: ${page.finalUrl}\n` : '';
        const title = page.title ? `Title: ${page.title}\n` : '';
        const header = `=== ${url} ===\n${resolved}${title}\n`;
        return header + windowContent(page.text, url, limit, offset);
      }),
    );
    return blocks.join('\n\n');
  },
});

/** ADK surface, ready for the registry. */
export const webExtractTool = toFunctionTool(webExtractContract);
