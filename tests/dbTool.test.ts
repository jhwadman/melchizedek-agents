/** The melchizedek-db bin's pure parts, offline. */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { installOrder, migrationFiles, pgEnv } from '../scripts/db.ts';

test('a DATABASE_URL becomes libpq variables, password decoded and never an argument', () => {
  const env = pgEnv('postgresql://u%40x:p%23w@db.example.co:6543/postgres');
  assert.deepStrictEqual(env, {
    PGHOST: 'db.example.co',
    PGPORT: '6543',
    PGUSER: 'u@x',
    PGPASSWORD: 'p#w',
    PGDATABASE: 'postgres',
    PGSSLMODE: 'require',
  });
  assert.throws(() => pgEnv('https://example.com'), /postgres:\/\//);
});

test('hardening revokes function execution from PUBLIC, not just the named roles', () => {
  const sql = readFileSync('db/hardening.sql', 'utf-8');
  assert.match(sql, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  for (const fn of ['match_turns', 'melchizedek_prune_telemetry', 'melchizedek_prune_sessions', 'match_memory_facts']) {
    assert.ok(sql.includes(`'${fn}'`), `${fn} must be covered by the function lockdown`);
  }
});

test('every migration is idempotent by construction and records its own version', () => {
  const files = migrationFiles('db/migrations');
  assert.ok(files.length >= 1);
  files.forEach((rel, i) => {
    const sql = readFileSync(`db/${rel}`, 'utf-8');
    const creates = sql.match(/CREATE (TABLE|INDEX|EXTENSION)\b(?! IF NOT EXISTS)/g) ?? [];
    assert.deepStrictEqual(creates, [], `${rel}: every CREATE TABLE/INDEX/EXTENSION must say IF NOT EXISTS`);
    const name = rel.replace(/^migrations\//, '').replace(/\.sql$/, '');
    assert.ok(sql.includes(`'${name}'`), `${rel} must insert its name into melchizedek_schema_version`);
    assert.ok(name.startsWith(String(i + 1).padStart(4, '0')), `${rel} is out of sequence`);
  });
});

test('the install order is migrations, then hardening (and again after telemetry)', () => {
  const order = installOrder(true);
  assert.strictEqual(order.at(-1), 'hardening.sql');
  assert.ok(order.indexOf('hardening.sql') > order.indexOf('migrations/0001_base.sql'));
  assert.ok(order.indexOf('telemetry.sql') > order.indexOf('hardening.sql'));
});
