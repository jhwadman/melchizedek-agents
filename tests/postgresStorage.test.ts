/**
 * tests/postgresStorage.test.ts — the direct-Postgres adapter against a REAL
 * Postgres with pgvector (ADR 0021): migrations, sessions under concurrent
 * appends, memory on the shared store, owner-scoped A2A tasks, erase, and a
 * full ADK turn persisted and resumed.
 *
 * Runs only when TEST_DATABASE_URL points at a Postgres server where the
 * connecting role may create databases, e.g.
 *   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/postgres npm test
 * Each run creates its own database, applies db/migrations/ and
 * db/telemetry.sql, and drops it. Without the variable every test skips.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { LlmAgent, Runner, setLogLevel, LogLevel } from '@google/adk';
import { ServerCallContext } from '@a2a-js/sdk/server';

import { postgresStorage } from '../lib/storage/postgres/index.ts';
import type { PostgresStorage } from '../lib/storage/postgres/index.ts';
import { persistedDelta } from '../lib/storage/postgres/sessionService.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';
import { ScriptedLlm, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);
process.env.OTEL_CONSOLE_SPANS = 'false';

const ADMIN_URL = process.env.TEST_DATABASE_URL;
const skip = ADMIN_URL ? false : 'set TEST_DATABASE_URL to run the Postgres integration suite';
const DB = `melchizedek_it_${process.pid}_${Date.now()}`;

let admin: pg.Client;
let storage: PostgresStorage;
let pool: pg.Pool;

function urlFor(db: string): string {
  const u = new URL(ADMIN_URL!);
  u.pathname = `/${db}`;
  return u.toString();
}

function migrations(): string[] {
  return ['db/migrations/0001_base.sql', 'db/migrations/0002_erase_scope.sql', 'db/migrations/0003_postgres_storage.sql', 'db/migrations/0004_usage.sql', 'db/telemetry.sql'];
}

// A 768-d embedding: identical for the same statement (a record's header is
// ignored, as a real embedding would mostly ignore it), near-orthogonal otherwise.
function vec(textIn: string): number[] {
  const v = new Array(768).fill(0);
  let h = 2166136261;
  for (const ch of textIn.replace(/^\[[^\]]*\]\s*/, '').toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  v[h % 768] = 1;
  v[(h >>> 10) % 768] += 0.5;
  return v;
}
const fakeEmbedder: Embedder = { provider: 'fake', model: 'fake', dimensions: 768, embed: async (t) => t.map(vec) };
function fakeExtractor(lines: string): MemoryExtractor {
  return { model: 'fake', extract: async () => lines };
}

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  pool = new pg.Pool({ connectionString: urlFor(DB), max: 8 });
  for (const f of [...migrations(), ...migrations()]) await pool.query(readFileSync(f, 'utf-8'));
  storage = postgresStorage({ pool, memory: { extractor: fakeExtractor(''), embedder: fakeEmbedder } });
});

after(async () => {
  if (skip) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();
});

test('migrations apply twice and record three versions', { skip }, async () => {
  const r = await pool.query('SELECT version, name FROM melchizedek_schema_version ORDER BY version');
  assert.deepEqual(
    r.rows.map((x) => `${x.version} ${x.name}`),
    ['1 0001_base', '2 0002_erase_scope', '3 0003_postgres_storage'],
  );
});

test('sessions: events are appended one row each, state deltas merge, temp: keys never persist', { skip }, async () => {
  const s = storage.sessionService;
  const session = await s.createSession({ appName: 'ns', userId: 'u', state: { a: 1 } });
  await s.appendEvent({
    session,
    event: { id: 'e1', author: 'user', invocationId: 'i', timestamp: 1, content: { role: 'user', parts: [{ text: 'hi' }] }, actions: { stateDelta: { b: 2, 'temp:x': 9 } } } as any,
  });
  await s.appendEvent({ session, event: { id: 'p', author: 'agent', partial: true, actions: {} } as any });
  const back = await s.getSession({ appName: 'ns', userId: 'u', sessionId: session.id });
  assert.deepEqual(back!.state, { a: 1, b: 2 });
  assert.equal(back!.events.length, 1, 'partial events are not stored');
  assert.equal((back!.events[0].content!.parts![0] as any).text, 'hi');
  assert.deepEqual(persistedDelta({ 'temp:a': 1, k: 2 }), { k: 2 });
});

test('sessions: two writers on one conversation both land, in order, with no lost event', { skip }, async () => {
  const s = storage.sessionService;
  const created = await s.createSession({ appName: 'ns', userId: 'race' });
  // Two "processes", each holding its own copy of the session.
  const a = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  const b = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  const ev = (n: number) => ({ id: `e${n}`, author: 'agent', invocationId: 'i', timestamp: n, content: { role: 'model', parts: [{ text: `t${n}` }] }, actions: { stateDelta: { [`k${n}`]: n } } }) as any;
  await Promise.all([
    ...[1, 3, 5, 7, 9].map((n) => s.appendEvent({ session: a!, event: ev(n) })),
    ...[2, 4, 6, 8, 10].map((n) => s.appendEvent({ session: b!, event: ev(n) })),
  ]);
  const back = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  assert.equal(back!.events.length, 10, 'every event from both writers is stored');
  assert.equal(Object.keys(back!.state).length, 10, 'every state key from both writers survives');
  const seqs = await pool.query('SELECT seq FROM adk_session_events WHERE session_id = $1 ORDER BY seq', [`ns:race:${created.id}`]);
  assert.deepEqual(seqs.rows.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  // A late "create" for the same id must not wipe what is there.
  await s.createSession({ appName: 'ns', userId: 'race', sessionId: created.id });
  const again = await s.getSession({ appName: 'ns', userId: 'race', sessionId: created.id, config: { numRecentEvents: 3 } });
  assert.equal(again!.events.length, 10 - 7, 'numRecentEvents returns the newest three');
  const lastThree = await pool.query(
    'SELECT event FROM adk_session_events WHERE session_id = $1 ORDER BY seq DESC LIMIT 3',
    [`ns:race:${created.id}`],
  );
  assert.deepEqual(again!.events.map((e) => e.id), lastThree.rows.map((r) => r.event.id).reverse(), 'oldest first');
});

test('sessions: list pages with the real total, delete cascades to events', { skip }, async () => {
  const s = storage.sessionService;
  for (let i = 0; i < 5; i++) await s.createSession({ appName: 'lister', userId: 'u', sessionId: `s${i}` });
  const page = await s.listSessions({ appName: 'lister', userId: 'u', limit: 2, page: 2, order: 'asc' });
  assert.equal(page.totalItems, 5);
  assert.equal(page.totalPages, 3);
  assert.equal(page.sessions.length, 2);
  assert.ok(page.sessions.every((x) => x.id.startsWith('s')));

  const one = await s.getSession({ appName: 'lister', userId: 'u', sessionId: 's0' });
  await s.appendEvent({ session: one!, event: { id: 'z', author: 'user', invocationId: 'i', timestamp: 1, actions: {} } as any });
  await s.deleteSession({ appName: 'lister', userId: 'u', sessionId: 's0' });
  const left = await pool.query("SELECT count(*)::int AS n FROM adk_session_events WHERE session_id = 'lister:u:s0'");
  assert.equal(left.rows[0].n, 0);
});

test('a full ADK turn persists to Postgres and the next turn resumes it', { skip }, async () => {
  const model = new ScriptedLlm('scripted-pg', (_req, n) => text(n === 1 ? 'Noted: green tea.' : 'You said green tea.'));
  const agent = new LlmAgent({ name: 'Desk', model, instruction: 'Answer briefly.' });
  const userId = `scope-${randomUUID()}`;
  const runTurn = async (message: string, sessionId: string) => {
    const runner = new Runner({ appName: 'turns.ns', agent, sessionService: storage.sessionService });
    let answer = '';
    for await (const ev of runner.runAsync({ userId, sessionId, newMessage: { role: 'user', parts: [{ text: message }] } })) {
      for (const p of ev.content?.parts ?? []) if (p.text && !ev.partial) answer = p.text;
    }
    return answer;
  };
  const session = await storage.sessionService.createSession({ appName: 'turns.ns', userId });
  assert.equal(await runTurn('I like green tea.', session.id), 'Noted: green tea.');
  // A different Runner (another instance) resumes from the database alone.
  assert.equal(await runTurn('What do I like?', session.id), 'You said green tea.');
  assert.ok(sentTexts(model.requests[1]).some((t) => t.includes('I like green tea.')), 'turn 2 saw turn 1');
  const stored = await pool.query('SELECT count(*)::int AS n FROM adk_session_events WHERE session_id = $1', [
    `turns.ns:${userId}:${session.id}`,
  ]);
  assert.equal(stored.rows[0].n, 4, 'two user messages and two answers');
});

test('memory: facts are stored, deduplicated, recalled and superseded on the Postgres store', { skip }, async () => {
  const mk = (lines: string) =>
    postgresStorage({ pool, memory: { extractor: fakeExtractor(lines), embedder: fakeEmbedder } }).memoryService!;
  const session = (id: string) =>
    ({ id, appName: 'mem.ns', userId: 'u1', events: [{ author: 'user', content: { role: 'user', parts: [{ text: 'stuff' }] } }] }) as any;

  await mk('[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.').addSessionToMemory(session('m1'));
  // The same fact again is a duplicate, not a second row.
  await mk('[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.').addSessionToMemory(session('m2'));
  let rows = await pool.query("SELECT fact, status FROM adk_memory_facts WHERE user_key = 'mem.ns/u1'");
  assert.equal(rows.rowCount, 1);

  // A correction retires what it supersedes.
  await mk(
    '[CORRECTION | date: 2026-10-02 | source: user | keys: tea | supersedes: The user prefers green tea.] The user now prefers black tea.',
  ).addSessionToMemory(session('m3'));
  rows = await pool.query("SELECT fact, status FROM adk_memory_facts WHERE user_key = 'mem.ns/u1' ORDER BY created_at");
  assert.deepEqual(rows.rows.map((r) => r.status), ['superseded', 'active']);

  const found = await mk('').searchMemory({ appName: 'mem.ns', userId: 'u1', query: 'The user now prefers black tea.' });
  assert.ok(found.memories.length >= 1);
  assert.match(JSON.stringify(found.memories[0]), /black tea/);
});

test('tasks: durable, owner-scoped, listed newest first with working page tokens', { skip }, async () => {
  const store = storage.taskStore('desk');
  const as = (user: string) => new ServerCallContext({ user: { isAuthenticated: true, userName: user } } as any);
  const task = (id: string, ts: string, contextId = 'c1') =>
    ({ id, contextId, status: { state: 3, timestamp: ts }, artifacts: [{ artifactId: 'a' }], history: [] }) as any;

  await store.save(task('t1', '2026-10-01T10:00:00Z'), as('alice'));
  await store.save(task('t2', '2026-10-01T11:00:00Z'), as('alice'));
  await store.save(task('t3', '2026-10-01T12:00:00Z', 'c2'), as('alice'));
  await store.save(task('t9', '2026-10-01T13:00:00Z'), as('bob'));

  assert.ok(await store.load('t1', as('alice')));
  assert.equal(await store.load('t1', as('bob')), undefined, "bob cannot read alice's task");
  assert.equal(await storage.taskStore('other-agent').load('t1', as('alice')), undefined, 'tasks are per agent');

  const p1 = await store.list({ pageSize: 2 } as any, as('alice'));
  assert.deepEqual(p1.tasks.map((t: any) => t.id), ['t3', 't2']);
  assert.equal(p1.totalSize, 3);
  assert.deepEqual((p1.tasks[0] as any).artifacts, [], 'artifacts omitted unless asked');
  const p2 = await store.list({ pageSize: 2, pageToken: p1.nextPageToken } as any, as('alice'));
  assert.deepEqual(p2.tasks.map((t: any) => t.id), ['t1']);
  assert.equal(p2.nextPageToken, '');
  const byContext = await store.list({ contextId: 'c2' } as any, as('alice'));
  assert.deepEqual(byContext.tasks.map((t: any) => t.id), ['t3']);
  const after = await store.list({ statusTimestampAfter: '2026-10-01T10:30:00Z' } as any, as('alice'));
  assert.deepEqual(after.tasks.map((t: any) => t.id), ['t3', 't2']);

  // A second save updates in place (a task's status changes over its life).
  await store.save({ ...task('t1', '2026-10-01T14:00:00Z'), status: { state: 4, timestamp: '2026-10-01T14:00:00Z' } }, as('alice'));
  assert.equal(((await store.load('t1', as('alice'))) as any).status.state, 4);
});

test('erase: one namespace, everywhere, and nested — exactly the scope, sub-agent rows included', { skip }, async () => {
  const seed = async () => {
    await pool.query('TRUNCATE adk_sessions, adk_session_events, adk_memory_facts, adk_turns, adk_telemetry, adk_payloads, adk_a2a_tasks');
    await pool.query(`
      INSERT INTO adk_memory_facts (user_key, fact) VALUES
        ('ns1/u1','a'),('ns1/u1','b'),('ns1/u2','c'),('ns2/u1','d'),('ns1/u1/end','e'),('melchizedek-a2a/u1','f'),('ns1/u1_x','g');
      INSERT INTO adk_sessions (id, app_name, user_id) VALUES
        ('ns1:u1:c1','ns1','u1'),('Scout:u1:c1','Scout','u1'),('ns1:u1:c2','ns1','u1'),
        ('ns2:u1:c9','ns2','u1'),('ns1:u2:c1','ns1','u2'),('ns1:u1/end:c3','ns1','u1/end');
      INSERT INTO adk_session_events (session_id, seq, event) VALUES ('ns1:u1:c1', 1, '{}'), ('Scout:u1:c1', 1, '{}');
      INSERT INTO adk_turns (ts, trace_id, span_id, syndicate, user_id, session_id) VALUES
        (now(),'t1','s1','x','u1','c1'),(now(),'t2','s2','x','u1','c2'),(now(),'t9','s9','y','u1','c9'),(now(),'t3','s3','x','u2','c1');
      INSERT INTO adk_telemetry (trace_id, span_id, span_name, span) VALUES ('t1','a','llm.request','{}'),('t9','c','llm.request','{}');
      INSERT INTO adk_payloads (ts, trace_id, span_id, reason) VALUES (now(),'t1','a','error');
      INSERT INTO adk_a2a_tasks (owner, agent_id, id, context_id, task) VALUES ('u1','desk','k1','c1','{}'),('u1','desk','k9','c9','{}');
    `);
  };
  const ids = async (sql: string) => (await pool.query(sql)).rows.map((r) => Object.values(r)[0]).sort();

  await seed();
  const a = await storage.erase('u1', { namespace: 'ns1' });
  assert.deepEqual(
    { ...a },
    { memory_facts: 2, sessions: 3, turns: 2, spans: 1, payloads: 1, verdicts: 0, labels: 0, tasks: 1 },
  );
  assert.deepEqual(await ids('SELECT user_key||\':\'||fact AS k FROM adk_memory_facts'), [
    'melchizedek-a2a/u1:f', 'ns1/u1/end:e', 'ns1/u1_x:g', 'ns1/u2:c', 'ns2/u1:d',
  ]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM adk_session_events')).rows[0].n, 0, 'events cascade');

  await seed();
  const b = await storage.erase('u1');
  assert.equal(b.memory_facts, 4);
  assert.equal(b.tasks, 2);
  assert.deepEqual(await ids('SELECT id FROM adk_sessions'), ['ns1:u1/end:c3', 'ns1:u2:c1']);

  await seed();
  const c = await storage.erase('u1', { namespace: 'ns1', includeNested: true });
  assert.equal(c.memory_facts, 3);
  assert.deepEqual(await ids('SELECT id FROM adk_sessions'), ['ns1:u2:c1', 'ns2:u1:c9']);

  await assert.rejects(storage.erase('  '), /scope key is required/);
});

test('the usage store adds atomically under concurrency and reads back per day and subject', { skip }, async () => {
  const { postgresUsageStore } = await import('../lib/a2a/policy.ts');
  const store = postgresUsageStore(pool);
  const d = { tasks: 1, llmCalls: 2, inputTokens: 30, outputTokens: 4, thinkingTokens: 1 };
  await Promise.all(Array.from({ length: 20 }, () => store.add('2026-10-01', 'caller:penguin', d)));
  assert.deepEqual(await store.get('2026-10-01', 'caller:penguin'), { tasks: 20, llmCalls: 40, inputTokens: 600, outputTokens: 80, thinkingTokens: 20 });
  assert.equal((await store.get('2026-10-02', 'caller:penguin')).tasks, 0);
  assert.equal((await store.get('2026-10-01', 'caller:ymir')).tasks, 0);
});
