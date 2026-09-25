/**
 * tests/taskTools.test.ts — offline tests for the task list and job queue.
 *
 * No model, no network: every test points MELCHIZEDEK_TASKS_FILE at a fresh
 * temp file and drives the contracts through executeContract, the same
 * validate-then-run path an agent's call takes, plus the worker-side
 * functions scripts/assistant_worker.ts calls.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { executeContract } from '../lib/tools/toolContract.ts';
import { resolveTools } from '../lib/toolRegistry.ts';
import {
  TASK_TOOL_CONTRACTS,
  MAX_ATTEMPTS,
  MAX_RESULT_CHARS,
  claimNextJob,
  finishJob,
  recoverInterruptedJobs,
  taskAddContract,
  taskGetContract,
  taskListContract,
  taskQueueContract,
  taskStorePath,
  taskUpdateContract,
} from '../lib/tools/taskTools.ts';

const dir = mkdtempSync(join(tmpdir(), 'melch-tasks-'));
let n = 0;
beforeEach(() => {
  process.env.MELCHIZEDEK_TASKS_FILE = join(dir, `tasks-${n++}.json`);
});
after(() => {
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  rmSync(dir, { recursive: true, force: true });
});

const call = (contract: any, args: unknown) => executeContract(contract, args);
const store = () => JSON.parse(readFileSync(taskStorePath(), 'utf8'));

// The public mirror ships its own sanitized registry (the export overlay), so
// this runs against whichever registry the repo has: a task tool missing from
// it would leave assistant.yaml calling tools that do not exist.
test('every task contract is registered by name', () => {
  const unknown: string[] = [];
  const names = TASK_TOOL_CONTRACTS.map((c) => c.name);
  assert.strictEqual(resolveTools(names, (n) => unknown.push(n)).length, names.length);
  assert.deepStrictEqual(unknown, []);
});

test('the store path is deployment config, never an argument', () => {
  assert.strictEqual(taskStorePath(), process.env.MELCHIZEDEK_TASKS_FILE);
  delete process.env.MELCHIZEDEK_TASKS_FILE;
  assert.strictEqual(taskStorePath(), join(process.cwd(), 'outputs', 'tasks.json'));
});

test('a todo is added, listed, completed, and leaves the active list', async () => {
  assert.match(await call(taskAddContract, { title: 'Buy milk', due: 'Friday' }), /^Added t1 \[open\] Buy milk \(due Friday\)/);
  assert.match(await call(taskListContract, {}), /t1 \[open\] Buy milk/);
  assert.match(await call(taskUpdateContract, { id: 't1', status: 'done' }), /t1 \[done\]/);
  assert.match(await call(taskListContract, {}), /^No tasks match/);
  assert.match(await call(taskListContract, { status: 'done' }), /t1 \[done\] Buy milk/);
});

test('ids come from the store and are never reused', async () => {
  await call(taskAddContract, { title: 'a' });
  await call(taskAddContract, { title: 'b' });
  assert.deepStrictEqual(store().tasks.map((t: any) => t.id), ['t1', 't2']);
  assert.strictEqual(store().next_id, 3);
});

test('schemas refuse malformed ids and oversized fields before any write', async () => {
  assert.match(await call(taskGetContract, { id: '../etc/passwd' }), /^Error: invalid arguments/);
  assert.match(await call(taskAddContract, { title: 'x'.repeat(201) }), /^Error: invalid arguments/);
  assert.match(await call(taskQueueContract, { title: 'j', instruction: 'short' }), /^Error: invalid arguments/);
  assert.match(await call(taskGetContract, { id: 't99' }), /^Error: no task t99/);
});

test('a background job runs queued → running → done and task_get shows the result', async () => {
  assert.match(
    await call(taskQueueContract, { title: 'Digest', instruction: 'Summarize https://example.com in three bullets.' }),
    /^Queued t1 \[queued · background\] Digest/,
  );
  assert.match(await call(taskGetContract, { id: 't1' }), /No result yet/);

  const job = claimNextJob();
  assert.strictEqual(job?.id, 't1');
  assert.strictEqual(job?.status, 'running');
  assert.strictEqual(claimNextJob(), null, 'a running job is not claimed twice');
  assert.match(await call(taskUpdateContract, { id: 't1', status: 'cancelled' }), /is running now/);

  finishJob('t1', { result: '- one\n- two\n- three' });
  const full = await call(taskGetContract, { id: 't1' });
  assert.match(full, /\[done · background\]/);
  assert.match(full, /result:\n- one/);
  assert.match(await call(taskListContract, { status: 'done' }), /result ready: task_get/);
  assert.match(await call(taskListContract, {}), /t1 \[done · background\]/, 'a fresh result stays on the active list');
});

test('a finished job leaves the active list after a week; a done todo leaves at once', async () => {
  await call(taskQueueContract, { title: 'Old job', instruction: 'Something from last month.' });
  claimNextJob();
  finishJob('t1', { result: 'ok' });
  const s = store();
  s.tasks[0].finished_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  writeFileSync(taskStorePath(), JSON.stringify(s));
  assert.match(await call(taskListContract, {}), /^No tasks match/);
  assert.match(await call(taskListContract, { status: 'all' }), /t1 \[done · background\] Old job/);
});

test('long results are cut at the cap with a marker', () => {
  writeFileSync(taskStorePath(), JSON.stringify({ version: 1, next_id: 1, tasks: [] }));
  return call(taskQueueContract, { title: 'Big', instruction: 'Write a very long document.' }).then(() => {
    claimNextJob();
    finishJob('t1', { result: 'x'.repeat(MAX_RESULT_CHARS + 500) });
    const saved = store().tasks[0].result as string;
    assert.ok(saved.length < MAX_RESULT_CHARS + 100);
    assert.match(saved, /cut at 20000 characters\]$/);
  });
});

test('status transitions are refused by kind', async () => {
  await call(taskAddContract, { title: 'todo' });
  await call(taskQueueContract, { title: 'job', instruction: 'Do the thing, completely.' });
  assert.match(await call(taskUpdateContract, { id: 't1', status: 'queued' }), /cannot be set to "queued"/);
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'done' }), /cannot be set to "done"/);
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'queued' }), /only a failed or cancelled job/);
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'cancelled' }), /\[cancelled · background\]/);
  assert.strictEqual(claimNextJob(), null, 'a cancelled job is not claimed');
  assert.match(await call(taskUpdateContract, { id: 't2', status: 'queued' }), /\[queued · background\]/);
  assert.strictEqual(claimNextJob()?.id, 't2');
});

test('a failed job records its error and can be retried', async () => {
  await call(taskQueueContract, { title: 'job', instruction: 'Read an unreachable page.' });
  claimNextJob();
  finishJob('t1', { error: 'OLLAMA_UNREACHABLE: start ollama' });
  assert.match(await call(taskGetContract, { id: 't1' }), /error: OLLAMA_UNREACHABLE/);
  assert.match(await call(taskListContract, {}), /t1 \[failed · background\]/, 'failed jobs stay on the active list');
  await call(taskUpdateContract, { id: 't1', status: 'queued' });
  const retried = store().tasks[0];
  assert.strictEqual(retried.status, 'queued');
  assert.strictEqual(retried.error, undefined);
  assert.strictEqual(retried.attempts, 0);
});

test('an interrupted job is re-queued, then failed after MAX_ATTEMPTS', async () => {
  await call(taskQueueContract, { title: 'job', instruction: 'Something that crashes the worker.' });
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    claimNextJob();
    assert.deepStrictEqual(recoverInterruptedJobs(), { requeued: ['t1'], failed: [] });
  }
  claimNextJob();
  assert.deepStrictEqual(recoverInterruptedJobs(), { requeued: [], failed: ['t1'] });
  assert.strictEqual(store().tasks[0].status, 'failed');
});

test('an unreadable store is an Error string, never a throw', async () => {
  writeFileSync(taskStorePath(), '{ not json');
  assert.match(await call(taskListContract, {}), /^Error: the task store could not be read/);
  writeFileSync(taskStorePath(), JSON.stringify({ something: 'else' }));
  assert.match(await call(taskAddContract, { title: 'x' }), /^Error: the task store could not be read/);
});
