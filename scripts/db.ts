#!/usr/bin/env node
/**
 * scripts/db.ts — the `melchizedek-db` bin and `npm run db -- <command>`.
 *
 * One place to install, check and maintain the database, so setup is not
 * "paste SQL out of a Markdown file". The SQL files ship in the package
 * (db/), and this prints or applies them in the one correct order.
 *
 *   print [--telemetry]   print every migration in db/migrations/ (in order),
 *                         then hardening.sql (+ telemetry.sql and hardening.sql
 *                         again) — pipe into psql or paste into the SQL Editor
 *   apply [--telemetry]   run the same files with psql against DATABASE_URL
 *                         (Supabase: Project Settings → Database → URI)
 *   status                schema version, RLS hardening and session counts,
 *                         over the Supabase API (SUPABASE_URL + service key)
 *   prune-sessions        delete expired sessions now (the nightly pg_cron job
 *                         does this when pg_cron is enabled)
 *
 * Never prints a credential: the connection string is passed to psql through
 * its environment, not its argument list.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadEnv } from '../lib/loadEnv.ts';
import { hasSupabaseCredentials } from '../lib/persistence/supabaseProvider.ts';

/** db/ of this package, from the source tree or from dist/. */
function dbDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'db', 'migrations'))) return join(dir, 'db');
    dir = dirname(dir);
  }
  throw new Error('db/migrations/ not found next to this package');
}

/** db/migrations/NNNN_name.sql, in numeric order. */
export function migrationFiles(dir: string = join(dbDir(), 'migrations')): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => `migrations/${f}`);
}

export function installOrder(withTelemetry: boolean): string[] {
  // Migrations first, in order. hardening.sql runs after them (and again
  // after telemetry.sql): it locks down whatever tables exist when it runs.
  const base = [...migrationFiles(), 'hardening.sql'];
  return withTelemetry ? [...base, 'telemetry.sql', 'hardening.sql'] : base;
}

/** postgres://user:pass@host:port/db?sslmode=… → libpq environment variables. */
export function pgEnv(url: string): Record<string, string> {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a postgres:// connection string');
  }
  const env: Record<string, string> = {};
  if (u.hostname) env.PGHOST = u.hostname;
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, '');
  if (db) env.PGDATABASE = decodeURIComponent(db);
  env.PGSSLMODE = u.searchParams.get('sslmode') ?? 'require';
  return env;
}

async function supabase() {
  if (!hasSupabaseCredentials()) {
    console.error('✗ SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (real values, not the .env.example placeholders).');
    process.exit(1);
  }
  const { createClient } = await import('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}

async function main(): Promise<void> {
  // `print | head` closes the pipe early; that is not an error.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  loadEnv(import.meta.url);
  const [command, ...rest] = process.argv.slice(2).filter((a) => a !== '--');
  const withTelemetry = rest.includes('--telemetry');

  switch (command) {
    case 'print': {
      for (const file of installOrder(withTelemetry)) {
        process.stdout.write(`\n-- ═════ db/${file} ═════\n`);
        process.stdout.write(readFileSync(join(dbDir(), file), 'utf-8'));
      }
      return;
    }
    case 'apply': {
      const url = process.env.DATABASE_URL;
      if (!url) {
        console.error('✗ DATABASE_URL is not set. Use `print` and paste into the SQL Editor instead,');
        console.error('  or set DATABASE_URL to the Postgres connection string (Supabase: Settings → Database).');
        process.exit(1);
      }
      for (const file of installOrder(withTelemetry)) {
        console.log(`→ applying db/${file}`);
        const r = spawnSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-f', join(dbDir(), file)], {
          stdio: 'inherit',
          // The connection goes to psql as PG* variables, never as an
          // argument, so the password stays out of the process list.
          env: { ...process.env, ...pgEnv(url) },
        });
        if (r.error) {
          console.error(`✗ could not run psql (${r.error.message}). Install the Postgres client, or use \`print\`.`);
          process.exit(1);
        }
        if (r.status !== 0) process.exit(r.status ?? 1);
      }
      console.log('✓ database is installed and hardened');
      return;
    }
    case 'status': {
      const db = await supabase();
      const version = await db.from('melchizedek_schema_version').select('version, name, applied_at').order('version');
      const shipped = migrationFiles().map((f) => f.replace(/^migrations\//, '').replace(/\.sql$/, ''));
      if (version.error) {
        console.log(`schema     not installed by db/migrations (${version.error.message}) — run \`print\` or \`apply\``);
      } else {
        const applied = new Set((version.data ?? []).map((r: any) => r.name));
        const missing = shipped.filter((m) => !applied.has(m));
        console.log(`schema     ${applied.size} migration(s) applied${missing.length ? `; NOT applied: ${missing.join(', ')}` : ', current'}`);
      }
      const rls = await db.rpc('melchizedek_rls_status');
      if (rls.error) {
        console.log(`hardening  NOT applied (${rls.error.message}) — run db/hardening.sql`);
      } else {
        const rows = (rls.data ?? []) as Array<{ table_name: string; rls_enabled: boolean }>;
        const off = rows.filter((r) => !r.rls_enabled).map((r) => r.table_name);
        console.log(off.length ? `hardening  RLS OFF on: ${off.join(', ')}` : `hardening  RLS on for ${rows.length} table(s)`);
      }
      const sessions = await db.from('adk_sessions').select('id', { count: 'exact', head: true });
      const expired = await db.from('adk_sessions').select('id', { count: 'exact', head: true }).lt('expire_at', new Date().toISOString());
      if (!sessions.error) console.log(`sessions   ${sessions.count ?? 0} stored, ${expired.count ?? 0} past expiry`);
      return;
    }
    case 'prune-sessions': {
      const db = await supabase();
      const { data, error } = await db.rpc('melchizedek_prune_sessions');
      if (error) {
        console.error(`✗ prune failed: ${error.message} (have the migrations been applied?)`);
        process.exit(1);
      }
      console.log(`✓ deleted ${data ?? 0} expired session(s)`);
      return;
    }
    default:
      console.log('Usage: melchizedek-db <print|apply|status|prune-sessions> [--telemetry]');
      process.exit(command ? 1 : 0);
  }
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedAsMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
