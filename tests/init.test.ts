/** melchizedek-init: a shipped template becomes a runnable, valid project file. */
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, shippedSyndicates } from '../scripts/init.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';

const fixedRandom = (n: number) => Buffer.alloc(n, 7);

test('templates and examples are listed', () => {
  const { templates, examples } = shippedSyndicates();
  assert.ok(templates.includes('conversational'));
  assert.ok(examples.includes('tutor'));
});

test('a template is copied with a schema modeline, nested files, and a valid result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-init-'));
  const r = initProject({ template: 'research_brief', as: 'brief', cwd: dir, random: fixedRandom });
  assert.ok(r.written.includes(join('config', 'agents', 'brief.yaml')));
  assert.ok(existsSync(join(dir, 'config', 'agents', 'research_desk.yaml')), 'the nested syndicate comes along');
  const text = readFileSync(join(dir, 'config', 'agents', 'brief.yaml'), 'utf-8');
  assert.match(text, /^# yaml-language-server: \$schema=.*syndicate\.schema\.json/);
  const cfg = loadSyndicate('brief.yaml', { agentsDir: join(dir, 'config', 'agents') });
  assert.ok(cfg.orchestrator.name);
});

test('a long-term memory template gets its own namespace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-init-'));
  const r = initProject({ template: 'account_memory', cwd: dir, random: fixedRandom });
  assert.match(r.namespace ?? '', /^account_memory\.[a-z2-7]{8}$/);
  const cfg = loadSyndicate('account_memory.yaml', { agentsDir: join(dir, 'config', 'agents') });
  assert.equal(cfg.memory_namespace, r.namespace);
});

test('an existing file is kept unless --force', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-init-'));
  initProject({ template: 'conversational', cwd: dir });
  const target = join(dir, 'config', 'agents', 'conversational.yaml');
  writeFileSync(target, 'mine');
  const r = initProject({ template: 'conversational', cwd: dir });
  assert.deepEqual(r.written, []);
  assert.equal(readFileSync(target, 'utf-8'), 'mine');
  initProject({ template: 'conversational', cwd: dir, force: true });
  assert.notEqual(readFileSync(target, 'utf-8'), 'mine');
});

test('an unknown template is a clear error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-init-'));
  assert.throws(() => initProject({ template: 'nope', cwd: dir }), /--list/);
});
