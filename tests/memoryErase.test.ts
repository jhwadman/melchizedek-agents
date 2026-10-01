/**
 * tests/memoryErase.test.ts — the erase call and the namespace pin
 * (ADR 0020 items 3 and 7). Offline: fake clients. The SQL itself is checked
 * for its contract here; it has not been run against a live database in
 * this suite.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { eraseScope } from '../lib/memory/erase.ts';
import { namespacedMemoryService } from '../lib/memory/namespace.ts';

test('eraseScope calls the SQL function and returns a count per store', async () => {
  let called: any;
  const client = {
    rpc: async (fn: string, args: any) => {
      called = { fn, args };
      return {
        data: [
          { store: 'memory_facts', deleted: 3 },
          { store: 'sessions', deleted: '2' },
          { store: 'turns', deleted: 5 },
        ],
        error: null,
      };
    },
  };
  const counts = await eraseScope(client as any, 'acme/user-7', { namespace: 'support_triage.k3f9q2a8' });
  assert.deepEqual(called, {
    fn: 'melchizedek_erase_scope',
    args: { p_scope_key: 'acme/user-7', p_namespace: 'support_triage.k3f9q2a8', p_include_nested: false },
  });
  assert.deepEqual(counts, {
    memory_facts: 3,
    sessions: 2,
    turns: 5,
    spans: 0,
    payloads: 0,
    verdicts: 0,
    labels: 0,
    tasks: 0,
  });
});

test('eraseScope refuses an empty scope and throws on a database error', async () => {
  const never = { rpc: async () => assert.fail('must not call the database') };
  await assert.rejects(eraseScope(never as any, '  '), /scope key is required/);

  const missing = { rpc: async () => ({ data: null, error: { message: 'Could not find the function public.melchizedek_erase_scope', code: 'PGRST202' } }) };
  await assert.rejects(eraseScope(missing as any, 'u'), /npm run db -- apply/);

  const broken = { rpc: async () => ({ data: null, error: { message: 'permission denied' } }) };
  await assert.rejects(eraseScope(broken as any, 'u'), /Erase failed for u: permission denied/);
});

test('the erase migration covers every store, revokes PUBLIC, and requires a scope', () => {
  const sql = readFileSync('db/migrations/0002_erase_scope.sql', 'utf-8');
  for (const store of ['memory_facts', 'sessions', 'turns', 'spans', 'payloads', 'verdicts', 'labels', 'tasks']) {
    assert.match(sql, new RegExp(`store := '${store}'`), store);
  }
  assert.match(sql, /REVOKE ALL ON FUNCTION melchizedek_erase_scope\(text, text, boolean\) FROM PUBLIC/);
  assert.match(sql, /scope_key is required/);
  assert.match(sql, /SECURITY INVOKER/);
});

test('namespacedMemoryService pins searches and ingestion to the root namespace', async () => {
  const seen: any[] = [];
  const base = {
    async searchMemory(req: any) {
      seen.push(['search', req.appName, req.userId]);
      return { memories: [] };
    },
    async addSessionToMemory(session: any, rules?: string) {
      seen.push(['add', session.appName, session.userId, rules]);
    },
    async deleteUserMemory(key: string) {
      seen.push(['delete', key]);
      return 1;
    },
  };
  const pinned = namespacedMemoryService(base as any, 'support_triage.k3f9q2a8');
  // A DELEGATE subagent searches under its own agent name; the pin overrides it.
  await pinned.searchMemory({ appName: 'Scout', userId: 'u1', query: 'tea' });
  await pinned.addSessionToMemory({ appName: 'Scout', userId: 'u1', id: 's', events: [] } as any, 'rules');
  assert.equal(await (pinned as any).deleteUserMemory('x/u1'), 1);
  assert.deepEqual(seen, [
    ['search', 'support_triage.k3f9q2a8', 'u1'],
    ['add', 'support_triage.k3f9q2a8', 'u1', 'rules'],
    ['delete', 'x/u1'],
  ]);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assignMemoryNamespace, newMemoryNamespace } from '../lib/memory/namespace.ts';
import { flagMemoryNamespaces } from '../lib/doctor.ts';

test('newMemoryNamespace is the name plus a generated identifier, within the schema charset', () => {
  const fixed = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => i));
  assert.equal(newMemoryNamespace('Support Triage!', fixed), 'support_triage.abcdefgh');
  assert.match(newMemoryNamespace('assistant'), /^assistant\.[a-z2-7]{8}$/);
  assert.notEqual(newMemoryNamespace('assistant'), newMemoryNamespace('assistant'));
});

test('assignMemoryNamespace writes one line after memory_system and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-'));
  try {
    const file = path.join(dir, 'account_memory.yaml');
    const original = '# header\nsyndicate_name: Accounts\nmemory_system: "long-term"\norchestrator:\n  name: Lead\n';
    fs.writeFileSync(file, original);
    const first = assignMemoryNamespace(file);
    assert.equal(first.status, 'assigned');
    assert.match(first.namespace, /^account_memory\.[a-z2-7]{8}$/);
    assert.equal(
      fs.readFileSync(file, 'utf-8'),
      original.replace('memory_system: "long-term"\n', `memory_system: "long-term"\nmemory_namespace: "${first.namespace}"\n`),
    );
    assert.deepEqual(assignMemoryNamespace(file), { status: 'unchanged', namespace: first.namespace });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the doctor flags an undeclared or shared namespace on the deployment\'s own syndicates only', () => {
  const s = (file: string, namespace: string, declared: boolean) =>
    ({ file, name: file, tier: 'gemini', rows: [], verdict: { state: 'ready', detail: '' }, memory: { namespace, declared } }) as any;
  const list = [
    s('desk.yaml', 'melchizedek-a2a', false),
    s('advisor.yaml', 'melchizedek-a2a', false),
    s('a.yaml', 'shared.abcd', true),
    s('b.yaml', 'shared.abcd', true),
    s('c.yaml', 'own.efgh', true),
    s('examples/ares.yaml', 'melchizedek-a2a', false),
  ];
  flagMemoryNamespaces(list);
  assert.match(list[0].memory.issue, /no memory_namespace.*shared with advisor\.yaml.*--fix-namespaces desk\.yaml/);
  assert.match(list[2].memory.issue, /"shared\.abcd" is shared with b\.yaml/);
  assert.equal(list[4].memory.issue, undefined);
  assert.equal(list[5].memory.issue, undefined, 'shipped examples are copied before use');
});
