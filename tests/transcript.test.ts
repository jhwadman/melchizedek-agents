/**
 * Cross-agent transcript sharing — fully offline, no API keys, no network.
 *
 * These assertions are written against a real production failure. Session
 * `discord-…-5787e017` (2026-08-15) held a complete four-turn thread across
 * three routes, and replaying it through ADK's own content processor showed
 * the Conversationalist receiving 118,013 bytes in which EVERY content had
 * `role: "user"` — the previous routes' answers, their private chain-of-
 * thought, and 35 KB of raw tool JSON, all indistinguishable from something
 * the human had typed. The session was shared; the conversation was not.
 *
 * So the load-bearing assertion below is the boring one: a past agent turn
 * must come out as `role: "model"`. Everything else follows from it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import type { Event } from '@google/adk';
import { projectTranscript, renderTranscriptDigest, trimEventForStorage } from '../lib/session/transcript.ts';

const user = (text: string): Event => ({ author: 'user', content: { role: 'user', parts: [{ text }] } } as Event);
const agent = (author: string, parts: unknown[]): Event =>
  ({ author, content: { role: 'model', parts } } as Event);

/** The shape the 2026-08-15 session actually stored. */
const THREAD: Event[] = [
  user('[System Context: Current Date is August 15, 2026] Should I buy MU on Monday?'),
  agent('Analyst', [
    { text: '**My Micron Monday Decision Strategy** Okay, so the question is…', thought: true },
    { functionCall: { name: 'load_memory', args: { query: 'MU' } } },
  ]),
  agent('Analyst', [
    { functionResponse: { name: 'load_memory', response: { memories: 'x'.repeat(23_000) } } },
  ]),
  agent('Analyst', [{ text: 'MU: accumulate under $130. Stop at $118.' }]),
  user('[System Context: Current Date is August 15, 2026] You are neglecting AI and security.'),
];

test('a past agent turn survives as a model turn, not as user text', () => {
  const projected = projectTranscript(THREAD, 'Conversationalist');
  const answer = projected.find(e => (e.content?.parts?.[0] as { text?: string })?.text?.includes('accumulate under $130'));
  assert.ok(answer, 'the previous route’s answer must reach the next route');
  assert.equal(answer!.content!.role, 'model');
});

test('a foreign turn is re-authored to the running agent so ADK keeps it as a model turn', () => {
  // ADK's getContents rewrites any event whose author differs from the
  // running agent into `role: "user"` prefixed "For context:". Re-authoring
  // is the whole mechanism — if this regresses, the prompt silently flattens.
  for (const event of projectTranscript(THREAD, 'Conversationalist')) {
    if (event.author !== 'user') assert.equal(event.author, 'Conversationalist');
  }
});

test('the speaking desk stays visible as a label', () => {
  const projected = projectTranscript(THREAD, 'Conversationalist');
  const answer = projected.find(e => (e.content?.parts?.[0] as { text?: string })?.text?.includes('accumulate'));
  assert.match((answer!.content!.parts![0] as { text: string }).text, /^\[Analyst\] /);
});

test('an agent reading its own past turns sees them unlabelled', () => {
  const projected = projectTranscript(THREAD, 'Analyst');
  const answer = projected.find(e => (e.content?.parts?.[0] as { text?: string })?.text?.includes('accumulate'));
  assert.equal((answer!.content!.parts![0] as { text: string }).text, 'MU: accumulate under $130. Stop at $118.');
});

test('private reasoning never reaches the next route', () => {
  // ADK's convertForeignEvent clones unrecognised parts verbatim, which put
  // the previous route's `thought: true` monologue into the prompt as USER
  // speech. Nothing carrying it may survive projection.
  const dumped = JSON.stringify(projectTranscript(THREAD, 'Conversationalist'));
  assert.ok(!dumped.includes('My Micron Monday Decision Strategy'));
  assert.ok(!dumped.includes('"thought"'));
});

test('tool calls and their payloads are dropped together', () => {
  const dumped = JSON.stringify(projectTranscript(THREAD, 'Conversationalist'));
  assert.ok(!dumped.includes('load_memory'));
  assert.ok(!dumped.includes('xxxxx'), 'a 23 KB tool payload must not be inlined into the prompt');
  // Dropping a call without its response (or the reverse) would leave ADK's
  // function-response pairing with a widowed half, which throws.
  assert.ok(!dumped.includes('functionCall') && !dumped.includes('functionResponse'));
});

test('user turns pass through untouched', () => {
  const projected = projectTranscript(THREAD, 'Conversationalist');
  const first = projected[0];
  assert.equal(first.author, 'user');
  assert.equal(first.content!.role, 'user');
});

test('camelCase toolCall/toolResponse parts are dropped too', () => {
  // Some providers emit these; ADK's `part.functionCall` checks miss them, so
  // they survived its conversion as empty noise.
  const events = [agent('XScout', [{ toolCall: { name: 'x_search' }, thoughtSignature: 'sig' }])];
  assert.deepEqual(projectTranscript(events, 'Conversationalist'), []);
});

test('an event that said nothing out loud disappears', () => {
  const events = [agent('XScout', [{ functionCall: { name: 'x_search', args: {} } }])];
  assert.deepEqual(projectTranscript(events, 'Conversationalist'), []);
});

test('history is bounded, and it is the OLDEST context that goes', () => {
  const long: Event[] = [];
  for (let i = 0; i < 40; i++) {
    long.push(user(`question ${i}`));
    long.push(agent('Analyst', [{ text: `answer ${i} ${'y'.repeat(2_000)}` }]));
  }
  const projected = projectTranscript(long, 'Conversationalist', { maxHistoryChars: 10_000 });
  const dumped = JSON.stringify(projected);
  assert.ok(dumped.includes('answer 39'), 'the newest exchange must always survive');
  assert.ok(!dumped.includes('answer 0'), 'the oldest exchange is what the budget drops');
});

test('a single oversized turn is elided, not dropped', () => {
  const events = [agent('XScout', [{ text: 'X RECON: ' + 'z'.repeat(9_000) }])];
  const [only] = projectTranscript(events, 'Conversationalist', { maxTurnChars: 500 });
  const text = (only.content!.parts![0] as { text: string }).text;
  assert.ok(text.startsWith('[XScout] X RECON: '));
  assert.ok(text.endsWith('[…turn truncated]'));
  assert.ok(text.length < 700);
});

test('projection is non-destructive — the stored events are untouched', () => {
  const before = JSON.stringify(THREAD);
  projectTranscript(THREAD, 'Conversationalist');
  assert.equal(JSON.stringify(THREAD), before);
});

test('turns are capped as well as characters', () => {
  // A character budget is not a bound on prompt SHAPE: a thread of short
  // exchanges fits 43 turns inside 40,000 chars, and 43 turns of history to
  // answer one question is attention tax no byte budget describes.
  const long: Event[] = [];
  for (let i = 0; i < 40; i++) {
    long.push(user(`q${i}`));
    long.push(agent('Analyst', [{ text: `a${i}` }]));
  }
  const projected = projectTranscript(long, 'Conversationalist', { maxHistoryTurns: 6 });
  assert.equal(projected.length, 6);
  const dumped = JSON.stringify(projected);
  assert.ok(dumped.includes('a39'), 'the newest exchange must always survive');
  assert.ok(!dumped.includes('"q0"'));
});

test('whichever ceiling binds first wins', () => {
  const long: Event[] = [];
  for (let i = 0; i < 40; i++) long.push(agent('XScout', [{ text: 'z'.repeat(1_000) }]));
  // chars bind long before the turn cap does
  assert.equal(projectTranscript(long, 'X', { maxHistoryChars: 3_500, maxHistoryTurns: 30 }).length, 4);
  // turns bind long before the char cap does
  assert.equal(projectTranscript(long, 'X', { maxHistoryChars: 999_999, maxHistoryTurns: 3 }).length, 3);
});

// ── What reaches durable storage ─────────────────────────────────────────

const toolEvent = (key: 'functionResponse' | 'toolResponse', body: unknown): Event =>
  ({ author: 'XScout', content: { role: 'user', parts: [{ [key]: { id: 'abc123', name: 'x_search', response: body } }] } } as unknown as Event);

test('thoughtSignature never reaches storage — it is 73% of every byte', () => {
  // The dominant cost in the stored record, and never read back: the
  // projection drops thought parts and tool traffic before any prompt, and
  // the memory service walks part.text alone. Measured across 128 live
  // sessions at 14.14 MB, one part of it reaching 115 KB.
  const e = { author: 'XScout', content: { role: 'model', parts: [
    { text: 'X RECON: …' },
    { toolCall: { name: 'x_search' }, thoughtSignature: 'B'.repeat(80_000) },
  ] } } as unknown as Event;
  const trimmed = trimEventForStorage(e);
  const dumped = JSON.stringify(trimmed);
  assert.ok(!dumped.includes('thoughtSignature'));
  assert.ok(!dumped.includes('BBBBB'));
  assert.ok(dumped.includes('X RECON'), 'the conversation itself must survive');
});

test('an oversized tool result is elided before it is stored', () => {
  const trimmed = trimEventForStorage(toolEvent('functionResponse', { html: 'x'.repeat(50_000) }));
  const dumped = JSON.stringify(trimmed);
  assert.ok(!dumped.includes('xxxxx'));
  assert.match(dumped, /chars dropped before storage/);
});

test('the camelCase toolResponse shape is trimmed too — it is the larger share', () => {
  const trimmed = trimEventForStorage(toolEvent('toolResponse', { search_suggestions: '<style>' + 'y'.repeat(40_000) }));
  assert.ok(!JSON.stringify(trimmed).includes('yyyyy'));
});

test('an elided result is still a result — id and name survive', () => {
  // ADK pairs calls to responses by id and throws on a widowed half
  // (rearrangeEventsForLatestFunctionResponse), so the shape must hold.
  const trimmed = trimEventForStorage(toolEvent('functionResponse', { big: 'x'.repeat(9_000) }));
  const part = (trimmed.content!.parts as any[])[0].functionResponse;
  assert.equal(part.id, 'abc123');
  assert.equal(part.name, 'x_search');
  assert.ok(part.response, 'the response must remain present, only smaller');
});

test('a small tool result passes through untouched', () => {
  const small = toolEvent('functionResponse', { price: 217.5 });
  assert.equal(trimEventForStorage(small), small);
});

test('conversation text is never trimmed', () => {
  const answer = agent('Analyst', [{ text: 'MU: '.repeat(5_000) }]);
  assert.equal(trimEventForStorage(answer), answer);
});

test('trimming does not mutate the live event — the tool loop still reads it', () => {
  // The caller applies this to the serialized copy only. If it mutated the
  // in-memory event, the running agent would lose its own tool result
  // mid-turn.
  const live = toolEvent('functionResponse', { html: 'x'.repeat(50_000) });
  const before = JSON.stringify(live);
  trimEventForStorage(live);
  assert.equal(JSON.stringify(live), before);
});

// ── The classifier's digest ──────────────────────────────────────────────

test('the digest carries BOTH sides of the exchange', () => {
  // The router lane held only user messages and the router's own verdicts,
  // so a challenge to an answer it had never seen read as small talk.
  const digest = renderTranscriptDigest(THREAD);
  assert.match(digest, /^user: Should I buy MU on Monday\?$/m);
  assert.match(digest, /^Analyst: MU: accumulate under \$130/m);
});

test('the digest is oldest-first and ends on the message being reacted to', () => {
  const lines = renderTranscriptDigest(THREAD).split('\n');
  assert.match(lines[0], /Should I buy MU/);
  assert.match(lines[lines.length - 1], /neglecting AI and security/);
});

test('the digest strips the harness date marker', () => {
  assert.ok(!renderTranscriptDigest(THREAD).includes('[System Context:'));
});

test('the digest carries no reasoning or tool payloads', () => {
  const digest = renderTranscriptDigest(THREAD);
  assert.ok(!digest.includes('My Micron Monday Decision Strategy'));
  assert.ok(!digest.includes('load_memory'));
});

test('the digest keeps only the newest maxTurns lines', () => {
  const long: Event[] = [];
  for (let i = 0; i < 20; i++) long.push(user(`message ${i}`));
  const lines = renderTranscriptDigest(long, { maxTurns: 3 }).split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines, ['user: message 17', 'user: message 18', 'user: message 19']);
});

test('an empty session yields an empty digest, so the router sees no block at all', () => {
  assert.equal(renderTranscriptDigest([]), '');
});
