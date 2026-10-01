/**
 * tests/xApiSearch.test.ts — offline tests for the x_api_search tool.
 *
 * NO network, NO keys: the call takes its fetch, its vision pass, its clock
 * and its environment through `XApiDeps`, so every path — the token guard,
 * the query hygiene, the page parser, the image gate and the rendered block
 * — runs against fixtures. The live shape of the API response was captured
 * from melch-research's collector, which has read it daily since 2026-08-25.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  EVIDENCE_RULES,
  imageMax,
  parsePostId,
  parseSearchJson,
  pickImages,
  readImage,
  renderBlock,
  runXApiSearch,
  sanitizeQuery,
  xApiSearchContract,
  type XApiDeps,
} from '../lib/tools/xApiSearchTool.ts';
import { executeContract } from '../lib/tools/toolContract.ts';

// ── Fixture: one page as /2/tweets/search/recent returns it ─────────────────

const PAGE = {
  data: [
    {
      id: '1001',
      author_id: 'u1',
      created_at: '2026-09-19T14:02:11.000Z',
      text: 'Strike map of the airport, 3 impacts confirmed https://t.co/abc https://t.co/media1',
      public_metrics: { like_count: 1203, retweet_count: 340, reply_count: 88, impression_count: 90000 },
      entities: {
        urls: [
          { url: 'https://t.co/abc', expanded_url: 'https://reut.rs/xyz', unwound_url: 'https://www.reuters.com/world/strike-2026-09-19/' },
          { url: 'https://t.co/media1', expanded_url: 'https://x.com/wire_desk/status/1001/photo/1' },
        ],
      },
      attachments: { media_keys: ['3_a', '7_b'] },
    },
    {
      id: '1002',
      author_id: 'u2',
      created_at: '2026-09-19T15:30:00.000Z',
      text: 'short',
      note_tweet: { text: 'The long version of this post runs well past two hundred and eighty characters and the API carries it in note_tweet.' },
      public_metrics: { like_count: 5, retweet_count: 0, reply_count: 1, impression_count: 200 },
      referenced_tweets: [{ type: 'quoted', id: '900' }],
      attachments: { media_keys: ['3_c'] },
    },
    { id: '1003', author_id: 'u1', created_at: '2026-09-18T09:00:00.000Z', text: 'no media here', public_metrics: {} },
  ],
  includes: {
    users: [
      { id: 'u1', username: 'wire_desk', name: 'Wire Desk', verified: true },
      { id: 'u2', username: 'someone', name: 'Someone' },
      { id: 'u9', username: 'official', name: 'Official Account' },
    ],
    tweets: [{ id: '900', author_id: 'u9', text: 'The original statement.' }],
    media: [
      { media_key: '3_a', type: 'photo', url: 'https://pbs.twimg.com/media/AAA.jpg', width: 1200, height: 800, alt_text: 'satellite map' },
      { media_key: '7_b', type: 'video', preview_image_url: 'https://pbs.twimg.com/ext_tw_video_thumb/BBB.jpg' },
      { media_key: '3_c', type: 'photo', url: 'https://evil.example.com/steal.jpg' },
    ],
  },
  meta: { result_count: 3 },
};

function fakeDeps(over: Partial<XApiDeps> & { calls?: string[] } = {}): XApiDeps & { calls: string[] } {
  const calls: string[] = over.calls ?? [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  return {
    calls,
    env: { X_BEARER_TOKEN: 'test-token', ...(over.env ?? {}) },
    now: over.now ?? (() => Date.parse('2026-09-20T12:00:00Z')),
    transcribe: over.transcribe ?? (async () => { calls.push('transcribe'); return 'KIND: map\nTEXT: King Khalid Airport\nSHOWS: three impact markers.\nATTRIBUTION: none visible'; }),
    fetch: over.fetch ?? (async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.startsWith('https://api.x.com/2/tweets/search/recent')) {
        return new Response(JSON.stringify(PAGE), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.startsWith('https://pbs.twimg.com/')) {
        return new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '4' } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  };
}

// ── Query hygiene ───────────────────────────────────────────────────────────

test('sanitizeQuery keeps the allowed grammar and drops the operators that would 400', () => {
  const q = sanitizeQuery('("cable cut" OR Baltic) from:Reuters -is:reply lang:en since:2026-09-01 min_faves:100 -until:2026-09-19 place_country:US');
  assert.strictEqual(q, '("cable cut" OR Baltic) from:Reuters -is:reply lang:en -is:retweet');
});

test('sanitizeQuery balances quotes and parentheses, normalizes curly quotes, and excludes retweets once', () => {
  assert.strictEqual(sanitizeQuery('“cable cut'), 'cable cut -is:retweet');
  assert.strictEqual(sanitizeQuery('(Baltic OR Finland cable'), 'Baltic OR Finland cable -is:retweet');
  assert.strictEqual(sanitizeQuery('AI czar is:retweet'), 'AI czar is:retweet');
  assert.strictEqual(sanitizeQuery('AI czar -is:retweet'), 'AI czar -is:retweet');
  assert.strictEqual(sanitizeQuery('($NVDA OR NVDA) lang:en -is:reply'), '($NVDA OR NVDA) lang:en -is:reply -is:retweet'); // cashtags survive
  assert.strictEqual(sanitizeQuery('   '), '');
  assert.strictEqual(sanitizeQuery(undefined), '');
});

test('sanitizeQuery cuts to the API limit on a word boundary', () => {
  const q = sanitizeQuery(Array.from({ length: 200 }, (_, i) => `word${i}`).join(' '));
  assert.ok(q.length <= 512);
  assert.ok(q.endsWith(' -is:retweet'), 'the retweet exclusion survives the cut');
  assert.match(q, /\bword\d+ -is:retweet$/, 'the cut lands on a whole word');
});

// ── Parsing ─────────────────────────────────────────────────────────────────

test('parseSearchJson joins users, media and quoted posts onto each post', () => {
  const posts = parseSearchJson(PAGE);
  assert.strictEqual(posts.length, 3);
  const [a, b, c] = posts;
  assert.strictEqual(a!.handle, 'wire_desk');
  assert.strictEqual(a!.authorVerified, true);
  assert.strictEqual(a!.url, 'https://x.com/wire_desk/status/1001');
  assert.deepStrictEqual(a!.links, ['https://www.reuters.com/world/strike-2026-09-19/']); // the self-media link is dropped
  assert.strictEqual(a!.metrics?.likes, 1203);
  assert.strictEqual(a!.media?.length, 2);
  assert.deepStrictEqual(a!.media?.[0], { key: '3_a', type: 'photo', url: 'https://pbs.twimg.com/media/AAA.jpg', alt: 'satellite map', width: 1200, height: 800 });
  assert.strictEqual(a!.media?.[1]?.type, 'video');
  assert.strictEqual(a!.media?.[1]?.preview, 'https://pbs.twimg.com/ext_tw_video_thumb/BBB.jpg');
  assert.match(b!.text, /^The long version/); // note_tweet wins over the truncated text
  assert.deepStrictEqual(b!.quoted, { handle: 'official', text: 'The original statement.' });
  assert.strictEqual(c!.media, undefined);
  assert.strictEqual(c!.authorVerified, true);
});

test('pickImages takes photos with a url only, in post order, up to the cap', () => {
  const posts = parseSearchJson(PAGE);
  assert.deepStrictEqual(pickImages(posts, 8).map((p) => p.media.key), ['3_a', '3_c']);
  assert.deepStrictEqual(pickImages(posts, 1).map((p) => p.media.key), ['3_a']);
  assert.deepStrictEqual(pickImages(posts, 0), []);
});

test('imageMax reads its dial and clamps it', () => {
  assert.strictEqual(imageMax({}), 8);
  assert.strictEqual(imageMax({ X_API_IMAGE_MAX: '0' }), 0);
  assert.strictEqual(imageMax({ X_API_IMAGE_MAX: '99' }), 20);
  assert.strictEqual(imageMax({ X_API_IMAGE_MAX: 'lots' }), 8);
});

// ── The image gate ──────────────────────────────────────────────────────────

test('readImage fetches from X’s media host only', async () => {
  const deps = fakeDeps();
  const refused = await readImage({ key: 'k', type: 'photo', url: 'https://evil.example.com/steal.jpg' }, deps);
  assert.deepStrictEqual(refused, { key: 'k', ok: false, reason: "image host evil.example.com is not X's media host" });
  assert.deepStrictEqual(deps.calls, [], 'nothing was fetched');
  const ok = await readImage({ key: 'k2', type: 'photo', url: 'https://pbs.twimg.com/media/AAA.jpg' }, deps);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(deps.calls, ['https://pbs.twimg.com/media/AAA.jpg', 'transcribe']);
});

test('readImage refuses non-image bodies and a failed vision pass without throwing', async () => {
  const html = fakeDeps({
    fetch: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  });
  const r1 = await readImage({ key: 'k', type: 'photo', url: 'https://pbs.twimg.com/media/X.jpg' }, html);
  assert.deepStrictEqual(r1, { key: 'k', ok: false, reason: 'not an image (text/html)' });
  const broken = fakeDeps({ transcribe: async () => { throw new Error('quota'); } });
  const r2 = await readImage({ key: 'k', type: 'photo', url: 'https://pbs.twimg.com/media/X.jpg' }, broken);
  assert.deepStrictEqual(r2, { key: 'k', ok: false, reason: 'vision pass failed: quota' });
});

// ── The whole call ──────────────────────────────────────────────────────────

test('no token means UNAVAILABLE, and nothing is fetched', async () => {
  const deps = fakeDeps({ env: { X_BEARER_TOKEN: '' } });
  const out = await runXApiSearch({ query: 'anything' }, deps);
  assert.match(out, /^X API SEARCH: UNAVAILABLE/);
  assert.match(out, /X_BEARER_TOKEN/);
  assert.deepStrictEqual(deps.calls, []);
});

test('a page renders every post verbatim, transcribes the photos it may, and names the rest', async () => {
  const deps = fakeDeps();
  const out = await runXApiSearch({ query: 'airport strike', days: 3 }, deps);

  // the request the API saw
  const req = deps.calls[0]!;
  const u = new URL(req);
  assert.strictEqual(u.origin + u.pathname, 'https://api.x.com/2/tweets/search/recent');
  assert.strictEqual(u.searchParams.get('query'), 'airport strike -is:retweet');
  assert.strictEqual(u.searchParams.get('max_results'), '20');
  assert.strictEqual(u.searchParams.get('sort_order'), 'relevancy');
  assert.strictEqual(u.searchParams.get('start_time'), '2026-09-17T12:00:00Z');
  assert.strictEqual(u.searchParams.get('end_time'), '2026-09-20T11:59:30Z');
  assert.match(u.searchParams.get('expansions')!, /attachments\.media_keys/);
  assert.match(u.searchParams.get('media.fields')!, /alt_text/);

  // the block the agent reads
  assert.match(out, /^X API SEARCH — X’s last 3 days \(2026-09-17 to 2026-09-20\), most relevant first, for: airport strike -is:retweet/);
  assert.match(out, /3 posts on one page \(20 slots; more may exist\)/);
  assert.match(out, /2 photos attached, 1 transcribed beneath their posts/);
  assert.ok(out.includes(EVIDENCE_RULES));
  assert.match(out, /- @wire_desk \(Wire Desk\) · verified · 2026-09-19 14:02Z · 1,203 likes, 340 reposts, 90,000 views/);
  assert.match(out, /https:\/\/x\.com\/wire_desk\/status\/1001 · links: https:\/\/www\.reuters\.com\/world\/strike-2026-09-19\//);
  assert.match(out, /IMAGE 1\/2 \(photo 1200×800; author alt: "satellite map"\), transcribed:\n {4}KIND: map\n {4}TEXT: King Khalid Airport/);
  assert.match(out, /IMAGE 2\/2 \(video still — not read: only photos are transcribed\)/);
  assert.match(out, /quotes @official: "The original statement\."/);
  assert.match(out, /IMAGE 1\/1 \(photo — could not be read: image host evil\.example\.com is not X's media host\)/);
  assert.match(out, /- @wire_desk \(Wire Desk\) · verified · 2026-09-18 09:00Z\n {2}"no media here"/);

  // exactly one image fetched, exactly one vision call, never the foreign host
  assert.deepStrictEqual(deps.calls.slice(1), ['https://pbs.twimg.com/media/AAA.jpg', 'transcribe']);
});

test('the image cap and read_images:false are honoured and said aloud', async () => {
  const capped = fakeDeps({ env: { X_BEARER_TOKEN: 't', X_API_IMAGE_MAX: '0' } });
  const out1 = await runXApiSearch({ query: 'airport' }, capped);
  assert.match(out1, /2 photos attached, 0 transcribed/);
  assert.match(out1, /IMAGE 1\/2 \(photo 1200×800; author alt: "satellite map" — not read: the page’s image cap was reached\)/);
  assert.ok(!capped.calls.includes('transcribe'));

  const off = fakeDeps();
  const out2 = await runXApiSearch({ query: 'airport', read_images: false }, off);
  assert.match(out2, /not read: the page’s image cap was reached/);
  assert.deepStrictEqual(off.calls.length, 1, 'only the search was fetched');
});

test('a failed search and an empty one are different sentences', async () => {
  const failed = fakeDeps({
    fetch: async () => new Response(JSON.stringify({ title: 'Unauthorized', status: 401 }), { status: 401 }),
  });
  const out1 = await runXApiSearch({ query: 'airport' }, failed);
  assert.match(out1, /THE SEARCH FAILED \(HTTP 401 — \{"title":"Unauthorized","status":401\}\)/);
  assert.match(out1, /report the X channel as unavailable in GAPS/);

  const empty = fakeDeps({
    fetch: async () => new Response(JSON.stringify({ meta: { result_count: 0 } }), { status: 200 }),
  });
  const out2 = await runXApiSearch({ query: 'airport' }, empty);
  assert.match(out2, /NO POSTS MATCHED\./);
  assert.match(out2, /says nothing about the world/);

  const dead = fakeDeps({ fetch: async () => { throw new Error('ECONNRESET'); } });
  const out3 = await runXApiSearch({ query: 'airport' }, dead);
  assert.match(out3, /THE SEARCH FAILED \(network: ECONNRESET\)/);
});

test('a 429 with a far-off reset fails with the reset time instead of waiting', async () => {
  let hits = 0;
  const limited = fakeDeps({
    fetch: async () => {
      hits++;
      return new Response('', { status: 429, headers: { 'x-rate-limit-reset': String(Math.floor(Date.parse('2026-09-20T12:10:00Z') / 1000)) } });
    },
  });
  const out = await runXApiSearch({ query: 'airport' }, limited);
  assert.match(out, /THE SEARCH FAILED \(HTTP 429 — rate limited until 2026-09-20T12:10:00Z\)/);
  assert.strictEqual(hits, 1, 'no retry against a window twenty minutes out');
});

test('an all-operator query is refused before any call is made', async () => {
  const deps = fakeDeps();
  const out = await runXApiSearch({ query: 'since:2026-01-01 until:2026-02-01' }, deps);
  assert.match(out, /THE SEARCH FAILED \(the query was empty after operator hygiene/);
  assert.deepStrictEqual(deps.calls, []);
});

test('the contract validates its arguments and returns an error string, never a throw', async () => {
  assert.strictEqual(xApiSearchContract.name, 'x_api_search');
  const bad = await executeContract(xApiSearchContract, { query: 'x', max_results: 500 });
  assert.match(bad, /^Error: invalid arguments for x_api_search: max_results/);
  const missing = await executeContract(xApiSearchContract, {});
  assert.match(missing, /^Error: invalid arguments for x_api_search: \(root\): pass either `query`/);
});

test('renderBlock reports a failure without a page', () => {
  const out = renderBlock(
    { query: 'q -is:retweet', days: 7, sort: 'recency', window: { start: '2026-09-13T12:00:00Z', end: '2026-09-20T11:59:30Z' }, max: 20, ok: false, reason: 'HTTP 503', posts: [] },
    new Map(), new Set(), 0,
  );
  assert.strictEqual(out.split('\n').length, 2);
  assert.match(out, /newest first, for: q -is:retweet\nTHE SEARCH FAILED \(HTTP 503\)/);
});

// ── The pasted link ─────────────────────────────────────────────────────────

test('parsePostId reads a bare id or any status link, and nothing else', () => {
  assert.strictEqual(parsePostId('2101559363584381365'), '2101559363584381365');
  assert.strictEqual(parsePostId('https://x.com/wire_desk/status/2101559363584381365?s=20'), '2101559363584381365');
  assert.strictEqual(parsePostId('1001'), undefined); // too short to be a post id
  assert.strictEqual(parsePostId('twitter.com/a/statuses/12345678'), '12345678');
  assert.strictEqual(parsePostId('see https://mobile.x.com/a/status/987654321 today'), '987654321');
  assert.strictEqual(parsePostId('https://x.com/wire_desk'), undefined);
  assert.strictEqual(parsePostId('NVDA'), undefined);
  assert.strictEqual(parsePostId(''), undefined);
});

test('a post lookup fetches THAT post by id, with its photos, and points at the thread', async () => {
  const one = { data: [{ ...PAGE.data[0], id: '2101559363584381365' }], includes: PAGE.includes };
  const deps = fakeDeps({
    fetch: async (input) => {
      const url = String(input);
      deps.calls.push(url);
      if (url.startsWith('https://api.x.com/2/tweets?')) return new Response(JSON.stringify(one), { status: 200 });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    },
  });
  const out = await runXApiSearch({ post: 'https://x.com/wire_desk/status/2101559363584381365' }, deps);
  const u = new URL(deps.calls[0]!);
  assert.strictEqual(u.origin + u.pathname, 'https://api.x.com/2/tweets');
  assert.strictEqual(u.searchParams.get('ids'), '2101559363584381365');
  assert.match(u.searchParams.get('expansions')!, /attachments\.media_keys/);
  assert.match(out, /^X API LOOKUP — post 2101559363584381365 — the post itself, as the API returns it\. 1 photo attached, 1 transcribed beneath it\. For the replies and quotes around it, search conversation_id:2101559363584381365\./);
  assert.ok(out.includes(EVIDENCE_RULES));
  assert.match(out, /- @wire_desk \(Wire Desk\) · verified/);
  assert.match(out, /IMAGE 1\/2 \(photo 1200×800; author alt: "satellite map"\), transcribed:/);
  assert.deepStrictEqual(deps.calls.slice(1), ['https://pbs.twimg.com/media/AAA.jpg', 'transcribe']);
});

test('a missing post and a bad reference are named, never described', async () => {
  const gone = fakeDeps({
    fetch: async () => new Response(JSON.stringify({ errors: [{ detail: 'Could not find tweet with ids: [2101559363584381365].', title: 'Not Found Error' }] }), { status: 200 }),
  });
  const out1 = await runXApiSearch({ post: '2101559363584381365' }, gone);
  assert.match(out1, /^X API LOOKUP — post 2101559363584381365\nNO SUCH POST — Could not find tweet with ids: \[2101559363584381365\]\./);
  assert.match(out1, /never describe a post you did not read/);

  const deps = fakeDeps();
  const out2 = await runXApiSearch({ post: 'https://x.com/wire_desk' }, deps);
  assert.match(out2, /is neither a post id nor an x\.com/);
  assert.deepStrictEqual(deps.calls, []);
});

test('the contract requires a query or a post', async () => {
  const neither = await executeContract(xApiSearchContract, { days: 3 });
  assert.match(neither, /^Error: invalid arguments for x_api_search: .*pass either `query`/);
  const both = await executeContract(xApiSearchContract, { query: '', post: '' });
  assert.match(both, /^Error: invalid arguments/);
});
