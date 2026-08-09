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
 *   Agents pass arbitrary URLs and this process may run server-side
 *   (A2A on Heroku), so http(s)-only plus a literal-host guard: loopback,
 *   RFC-1918, link-local/metadata (169.254.*), CGNAT, ULA/IPv6-local and
 *   localhost-ish hostnames are refused, and redirects are followed
 *   manually so every hop is re-checked. Deliberate v1 limit: the guard
 *   inspects literals only — it does not resolve DNS, so a public
 *   hostname that resolves privately can still slip; acceptable for a
 *   tool that runs with no ambient credentials, revisit if that changes.
 *
 * FAILURE CONTRACT: never throws. Each URL yields either its content
 *   block or an inline `Error:` block; one bad URL never sinks the rest.
 */

import { z } from 'zod';

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

/** Reason the host is refused, or null when it looks routable. Literals only — see header. */
export function blockedHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    return 'local hostname';
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return 'private/loopback IPv4';
    if (a === 169 && b === 254) return 'link-local/metadata IPv4';
    if (a === 172 && b >= 16 && b <= 31) return 'private IPv4';
    if (a === 192 && b === 168) return 'private IPv4';
    if (a === 100 && b >= 64 && b <= 127) return 'CGNAT IPv4';
    return null;
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return 'IPv6 loopback/unspecified';
    if (/^f[cd]/.test(host)) return 'IPv6 unique-local';
    if (host.startsWith('fe80')) return 'IPv6 link-local';
    if (host.startsWith('::ffff:')) return blockedHostReason(host.slice(7)) ?? null;
  }
  return null;
}

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

/** Validate scheme + host; returns an error string or the parsed URL. */
function checkUrl(raw: string): URL | string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `Error: "${raw}" is not a valid absolute URL.`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: only http(s) URLs are supported (got ${parsed.protocol}//).`;
  }
  const blocked = blockedHostReason(parsed.hostname);
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
      const checked = checkUrl(next.toString());
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
    return isHtml ? extractHtml(body) : { title: null, text: body.trim() };
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
    'the `offset` from the marker. Up to 5 URLs per call. HTML and plain text only (no PDFs).',
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
        const checked = checkUrl(raw.trim());
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
        const header = page.title ? `=== ${url} ===\nTitle: ${page.title}\n\n` : `=== ${url} ===\n\n`;
        return header + windowContent(page.text, url, limit, offset);
      }),
    );
    return blocks.join('\n\n');
  },
});

/** ADK surface, ready for the registry. */
export const webExtractTool = toFunctionTool(webExtractContract);
