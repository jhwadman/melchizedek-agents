/**
 * Grounding provenance — offline. Native Gemini search never appears as a
 * function call; these helpers are what makes a searched answer visible in
 * the [A2A] log and in a client's sources footer.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import {
  groundingDomain, collectGrounding, newGroundingState, describeGrounding, webSourcesLine,
} from '../lib/grounding.ts';

const chunk = (title: string, uri = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQ') => ({ web: { title, uri } });

test('groundingDomain prefers the bare-domain title, falls back to the URI host', () => {
  assert.strictEqual(groundingDomain(chunk('reuters.com')), 'reuters.com');
  assert.strictEqual(groundingDomain(chunk('SEC.gov')), 'sec.gov');
  assert.strictEqual(groundingDomain({ web: { title: 'Some Article Headline', uri: 'https://www.example.org/x/y' } }), 'example.org');
  assert.strictEqual(groundingDomain({ web: { title: 'Headline only', uri: 'not a url' } }), 'Headline only');
  assert.strictEqual(groundingDomain({}), null);
});

test('collectGrounding dedupes across events and reports only when something new arrived', () => {
  const st = newGroundingState();
  const ev1 = { groundingMetadata: { webSearchQueries: ['NKE earnings date', ' NKE earnings date '], groundingChunks: [chunk('robinhood.com'), chunk('youtube.com')] } };
  assert.strictEqual(collectGrounding(ev1, st), true);
  assert.deepStrictEqual([...st.queries], ['NKE earnings date']);
  assert.deepStrictEqual([...st.sources], ['robinhood.com', 'youtube.com']);
  // Same metadata replayed on a streaming chunk → nothing new → no second log line.
  assert.strictEqual(collectGrounding(ev1, st), false);
  // A later event adds one source.
  assert.strictEqual(collectGrounding({ groundingMetadata: { groundingChunks: [chunk('sec.gov')] } }, st), true);
  assert.strictEqual(collectGrounding({ content: { parts: [{ text: 'no grounding' }] } }, st), false);
  assert.strictEqual(collectGrounding({ groundingMetadata: {} }, st), false);
});

test('log body and consumer line render the way RouteTrace expects', () => {
  const st = newGroundingState();
  assert.strictEqual(webSourcesLine(st), null);
  assert.strictEqual(describeGrounding(st), '0 queries · 0 sources');
  collectGrounding({ groundingMetadata: { webSearchQueries: ['q'], groundingChunks: [chunk('reuters.com'), chunk('sec.gov')] } }, st);
  assert.strictEqual(describeGrounding(st), '1 query · 2 sources (reuters.com, sec.gov)');
  // Exactly the shape a client's sources parser reads.
  assert.strictEqual(webSourcesLine(st), 'Web sources: reuters.com, sec.gov');
  assert.match(webSourcesLine(st)!, /^Web sources:\s*(.+)$/);
});
