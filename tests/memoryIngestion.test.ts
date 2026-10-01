/**
 * Memory ingestion is at-least-once: a failed extraction, embedding or
 * insert leaves the session's turns pending, and the next ingestion of the
 * same session retries them. Before 2026-10 every one of those failures was
 * swallowed and the watermark moved past turns that were never distilled.
 * Offline: a fake model client and a fake Supabase client.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';
import type { Embedder, MemoryExtractor } from '../lib/memory/providers.ts';

/** A memory service whose extractor and embedder are the given fakes. */
function service(client: unknown, extract: () => Promise<string>, embed: () => Promise<number[]>) {
  const extractor: MemoryExtractor = { model: 'fake-extractor', extract };
  const embedder: Embedder = {
    provider: 'fake',
    model: 'fake-embedder',
    dimensions: 768,
    embed: async (texts) => Promise.all(texts.map(() => embed())),
  };
  return new SupabaseVectorMemoryService({ apiKey: 'test', extractor, embedder }, client as any);
}
const VECTOR = () => new Array(768).fill(0.01);

function fakeSupabase() {
  const inserted: Array<Record<string, unknown>> = [];
  const chain = (result: unknown) => {
    const c: any = {
      select: () => c,
      eq: () => c,
      in: () => c,
      then: (resolve: (v: unknown) => void) => resolve(result),
    };
    return c;
  };
  const client: any = {
    from: () => ({
      select: () => chain({ data: [], error: null }),
      insert: (rows: Array<Record<string, unknown>>) => ({
        select: async () => {
          inserted.push(...rows);
          return { data: rows.map((r, i) => ({ id: `id-${inserted.length + i}`, fact: r.fact })), error: null };
        },
      }),
      update: () => chain({ data: [], error: null }),
    }),
    rpc: async () => ({ data: [], error: null }),
  };
  return { client, inserted };
}

const RECORD = '[PREFERENCE | date: 2026-10-01 | source: user | keys: tea] The user prefers green tea.';

function session(events: number) {
  return {
    id: 's1',
    appName: 'app',
    userId: 'u1',
    events: Array.from({ length: events }, (_, i) => ({
      author: i % 2 ? 'agent' : 'user',
      content: { role: i % 2 ? 'model' : 'user', parts: [{ text: i % 2 ? 'Noted.' : 'I prefer green tea.' }] },
    })),
  } as any;
}

test('a failed extraction leaves the turns pending and the next ingestion stores them', async () => {
  const { client, inserted } = fakeSupabase();
  let fail = true;
  let calls = 0;
  const svc = service(
    client,
    async () => {
      calls += 1;
      if (fail) throw new Error('503 overloaded');
      return RECORD;
    },
    async () => VECTOR(),
  );

  await assert.rejects(svc.addSessionToMemory(session(2)), /extraction failed/i);
  assert.strictEqual(inserted.length, 0);

  fail = false;
  await svc.addSessionToMemory(session(2));
  assert.strictEqual(inserted.length, 1, 'the same turns are retried and stored');

  // Now the watermark has advanced: the same events are not re-extracted.
  calls = 0;
  await svc.addSessionToMemory(session(2));
  assert.strictEqual(calls, 0);
});

test('a failed embedding also leaves the turns pending', async () => {
  const { client, inserted } = fakeSupabase();
  let embedFails = true;
  const svc = service(
    client,
    async () => RECORD,
    async () => {
      if (embedFails) throw new Error('429');
      return VECTOR();
    },
  );
  await assert.rejects(svc.addSessionToMemory(session(2)), /Embedding failed/);
  embedFails = false;
  await svc.addSessionToMemory(session(2));
  assert.strictEqual(inserted.length, 1);
});
