/**
 * tests/sessionPaging.test.ts — the ListSessions paging contract.
 *
 * ADK's ListSessionsRequest carries `limit` with either `page` (1-based,
 * takes precedence) or `offset` (0-based), plus an optional sort, and the
 * response must report page/limit/totalItems/totalPages. The window is
 * pushed down to Postgres, so what this guards is the arithmetic between
 * the request and the .range() call — the part that silently returns the
 * wrong slice when it is wrong.
 *
 * No network: the Supabase client is a recording stub.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { SupabaseSessionService } from '../lib/session/supabaseSessionService.ts';

interface Recorded {
  range?: [number, number];
  order?: { column: string; ascending: boolean };
  countRequested: boolean;
}

/** Minimal thenable stand-in for the chainable query builder. */
function stubClient(rows: unknown[], total: number): { client: any; seen: Recorded } {
  const seen: Recorded = { countRequested: false };
  const builder: any = {
    select: (_cols: string, opts?: { count?: string }) => {
      seen.countRequested = opts?.count === 'exact';
      return builder;
    },
    eq: () => builder,
    order: (column: string, opts: { ascending: boolean }) => {
      seen.order = { column, ascending: opts.ascending };
      return builder;
    },
    range: (from: number, to: number) => {
      seen.range = [from, to];
      return builder;
    },
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: rows, error: null, count: total }),
  };
  return { client: { from: () => builder }, seen };
}

const row = (id: string) => ({
  id: `app:user:${id}`,
  app_name: 'app',
  user_id: 'user',
  state: {},
  last_update_time: 1,
});

test('listSessions: no paging asked for means one page of everything', async () => {
  const { client, seen } = stubClient([row('a'), row('b')], 2);
  const service = new SupabaseSessionService(client);

  const res = await service.listSessions({ appName: 'app', userId: 'user' });

  assert.equal(res.sessions.length, 2);
  assert.equal(res.sessions[0].id, 'a', 'the composite key is unwrapped');
  assert.deepEqual(
    { page: res.page, limit: res.limit, totalItems: res.totalItems, totalPages: res.totalPages },
    { page: 1, limit: 2, totalItems: 2, totalPages: 1 },
    'limit equals totalItems when none was requested',
  );
  assert.equal(seen.range, undefined, 'no window is pushed down');
  assert.ok(seen.countRequested);
});

test('listSessions: page wins over offset, and totals describe the whole set', async () => {
  const { client, seen } = stubClient([row('c')], 25);
  const service = new SupabaseSessionService(client);

  const res = await service.listSessions({
    appName: 'app',
    userId: 'user',
    limit: 10,
    page: 3,
    offset: 99, // ignored: page takes precedence
    order: 'desc',
  });

  assert.deepEqual(seen.range, [20, 29], 'page 3 of 10 is rows 20–29');
  assert.deepEqual(seen.order, { column: 'last_update_time', ascending: false });
  assert.deepEqual(
    { page: res.page, limit: res.limit, totalItems: res.totalItems, totalPages: res.totalPages },
    { page: 3, limit: 10, totalItems: 25, totalPages: 3 },
    'totals count every matching row, not the slice',
  );
});

test('listSessions: offset alone is honoured, and a partial last page still counts', async () => {
  const { client, seen } = stubClient([row('d')], 7);
  const service = new SupabaseSessionService(client);

  const res = await service.listSessions({
    appName: 'app',
    userId: 'user',
    limit: 3,
    offset: 6,
  });

  assert.deepEqual(seen.range, [6, 8]);
  assert.equal(res.page, 3, 'offset 6 at size 3 is the third page');
  assert.equal(res.totalPages, 3, '7 rows at size 3 is three pages, not two');
});
