/**
 * tests/webExtract.test.ts — offline tests for the web_extract tool.
 *
 * Everything here runs with NO network: the fetch path is exercised only up
 * to the pure guards (scheme + SSRF checks reject before any socket opens);
 * the HTML pipeline, entity decoding, and windowing are pure functions.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  blockedHostReason,
  clearWebExtractCache,
  decodeEntities,
  extractCharLimit,
  extractHtml,
  webExtractContract,
  windowContent,
} from '../lib/tools/webExtractTool.ts';
import { executeContract } from '../lib/tools/toolContract.ts';

// ── SSRF guard ───────────────────────────────────────────────────────────────

test('blockedHostReason refuses local and private hosts', () => {
  for (const host of [
    'localhost',
    'api.localhost',
    'printer.local',
    'db.internal',
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:192.168.0.1',
  ]) {
    assert.ok(blockedHostReason(host), `expected ${host} to be blocked`);
  }
});

test('blockedHostReason allows routable hosts', () => {
  for (const host of ['example.com', 'www.reuters.com', '8.8.8.8', '172.32.0.1', '2606:4700::6810:84e5']) {
    assert.strictEqual(blockedHostReason(host), null, `expected ${host} to be allowed`);
  }
});

// ── HTML extraction ─────────────────────────────────────────────────────────

const FIXTURE = `
<!doctype html><html><head><title>Fed Holds &amp; Markets Rally</title>
<style>body { color: red }</style><script>alert(1)</script></head>
<body>
<nav><a href="/home">Home</a><a href="/news">News</a></nav>
<header>Site chrome that should vanish</header>
<article>
  <h1>Fed Holds Rates</h1>
  <p>The committee voted 11&ndash;1 to hold.</p>
  <img src="data:image/png;base64,AAAA" alt="Vote chart">
  <ul><li>First point</li><li>Second point</li></ul>
  <blockquote>We remain data dependent.</blockquote>
  <p>Read the <a href="https://example.com/statement">full statement</a>.</p>
</article>
<footer>Copyright &copy; 2026</footer>
</body></html>`;

test('extractHtml prefers <article>, strips chrome, converts structure', () => {
  const { title, text } = extractHtml(FIXTURE);
  assert.strictEqual(title, 'Fed Holds & Markets Rally');
  assert.match(text, /^# Fed Holds Rates/m);
  assert.match(text, /voted 11–1 to hold/);
  assert.match(text, /\[IMAGE: Vote chart\]/);
  assert.match(text, /- First point/);
  assert.match(text, /- Second point/);
  assert.match(text, /> We remain data dependent/);
  assert.match(text, /\[full statement\]\(https:\/\/example\.com\/statement\)/);
  assert.doesNotMatch(text, /alert\(1\)/);
  assert.doesNotMatch(text, /color: red/);
  assert.doesNotMatch(text, /Site chrome/);
  assert.doesNotMatch(text, /Copyright/);
  assert.doesNotMatch(text, /base64/);
});

test('extractHtml falls back to <body> when no article/main exists', () => {
  const { text } = extractHtml('<html><body><p>Plain page text.</p></body></html>');
  assert.match(text, /Plain page text\./);
});

test('decodeEntities handles named, decimal, and hex forms', () => {
  assert.strictEqual(decodeEntities('a &amp; b &#8212; &#x27;c&#x27;&nbsp;end'), "a & b — 'c' end");
});

// ── Windowing ───────────────────────────────────────────────────────────────

test('windowContent passes short pages through whole', () => {
  assert.strictEqual(windowContent('short page', 'https://e.com', 2000), 'short page');
});

test('windowContent truncates head+tail with a continuation marker', () => {
  const text = 'A'.repeat(6000) + 'MID' + 'B'.repeat(6000);
  const out = windowContent(text, 'https://e.com/a', 2000);
  assert.ok(out.startsWith('A'.repeat(100)));
  assert.ok(out.endsWith('B'.repeat(100)));
  assert.match(out, /omitted — web_extract\(\{"urls":\["https:\/\/e\.com\/a"\],"offset":1500\}\)/);
  assert.doesNotMatch(out, /MID/);
});

test('windowContent offset resumes and reports remaining chars', () => {
  const text = 'X'.repeat(10_000);
  const out = windowContent(text, 'https://e.com/a', 2000, 1500);
  assert.match(out, /^\[resuming at char 1500 of 10000\]/);
  assert.match(out, /6500 chars remain — web_extract\(\{"urls":\["https:\/\/e\.com\/a"\],"offset":3500\}\)/);
  const done = windowContent('Y'.repeat(100), 'https://e.com/a', 2000, 50);
  assert.doesNotMatch(done, /remain/);
  const past = windowContent('Z'.repeat(10), 'https://e.com/a', 2000, 99);
  assert.match(past, /past the end/);
});

// ── Contract behavior (no network: guards reject first) ─────────────────────

test('execute validates arguments as error strings, never throws', async () => {
  clearWebExtractCache();
  assert.match(await executeContract(webExtractContract, {}), /^Error: invalid arguments/);
  assert.match(
    await executeContract(webExtractContract, { urls: Array(6).fill('https://e.com') }),
    /^Error: invalid arguments/,
  );
  assert.match(
    await executeContract(webExtractContract, {
      urls: ['https://a.com', 'https://b.com'],
      offset: 100,
    }),
    /offset.*exactly one url/i,
  );
});

test('execute rejects bad schemes and blocked hosts without fetching', async () => {
  clearWebExtractCache();
  const out = await executeContract(webExtractContract, {
    urls: ['ftp://example.com/file', 'not a url', 'http://169.254.169.254/latest/meta-data'],
  });
  assert.match(out, /only http\(s\) URLs/);
  assert.match(out, /not a valid absolute URL/);
  assert.match(out, /refusing to fetch 169\.254\.169\.254/);
});

// ── Env config ──────────────────────────────────────────────────────────────

test('extractCharLimit clamps and survives malformed env values', () => {
  const prev = process.env.WEB_EXTRACT_CHAR_LIMIT;
  try {
    delete process.env.WEB_EXTRACT_CHAR_LIMIT;
    assert.strictEqual(extractCharLimit(), 15_000);
    process.env.WEB_EXTRACT_CHAR_LIMIT = '50000';
    assert.strictEqual(extractCharLimit(), 50_000);
    process.env.WEB_EXTRACT_CHAR_LIMIT = '10';
    assert.strictEqual(extractCharLimit(), 2_000);
    process.env.WEB_EXTRACT_CHAR_LIMIT = '9999999';
    assert.strictEqual(extractCharLimit(), 500_000);
    process.env.WEB_EXTRACT_CHAR_LIMIT = 'banana';
    assert.strictEqual(extractCharLimit(), 15_000);
  } finally {
    if (prev === undefined) delete process.env.WEB_EXTRACT_CHAR_LIMIT;
    else process.env.WEB_EXTRACT_CHAR_LIMIT = prev;
  }
});
