#!/usr/bin/env node
/**
 * scripts/telemetry_admin.ts — operate the observability ledger.
 *
 *   npm run telemetry:stats                 rows, last write, export lag per table
 *   npm run telemetry:prune [-- --turn-days N]
 *                                           expire payloads (and optionally old turns)
 *   npm run telemetry:replay                re-send the dead-letter spool, then clear it
 *   npm run telemetry:embed [-- --limit N]  embed turns that have no embedding yet (semantic search)
 *
 * All three use the service-role client from .env; none touch inference.
 */

import { existsSync, readFileSync, renameSync } from 'node:fs';

import { loadEnv } from '../lib/loadEnv.ts';
import { deadLetterPath } from '../lib/observability/supabaseSpanExporter.ts';
import { embedTexts, turnEmbeddingText } from '../lib/observability/embeddings.ts';
import { hasSupabaseCredentials } from '../lib/persistence/supabaseProvider.ts';

loadEnv(import.meta.url);

const argv = process.argv.slice(2).filter((a) => a !== '--');
const command = argv[0] ?? 'stats';
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
};

if (!hasSupabaseCredentials()) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set.');
  process.exit(1);
}

const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const TABLES = ['adk_turns', 'adk_telemetry', 'adk_payloads'] as const;

async function stats(): Promise<void> {
  console.log(`telemetry sink: ${process.env.TELEMETRY_SUPABASE === 'true' ? 'enabled' : 'DISABLED (TELEMETRY_SUPABASE != true)'}`);
  console.log(`payload policy: ${process.env.TELEMETRY_PAYLOADS ?? 'sample'} (sample ${process.env.TELEMETRY_PAYLOAD_SAMPLE ?? '0.10'}, ttl ${process.env.TELEMETRY_PAYLOAD_TTL_DAYS ?? '30'}d)`);
  console.log('');
  console.log(`${'table'.padEnd(16)} ${'rows'.padStart(9)}  ${'last 24h'.padStart(9)}  last write            lag`);
  for (const table of TABLES) {
    const total = await supabase.from(table).select('id', { count: 'exact', head: true });
    if (total.error) {
      console.log(`${table.padEnd(16)} ${'missing'.padStart(9)}  ${total.error.message.slice(0, 60)}`);
      continue;
    }
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const recent = await supabase.from(table).select('id', { count: 'exact', head: true }).gte('ts', since);
    const last = await supabase.from(table).select('ts').order('ts', { ascending: false }).limit(1);
    const lastTs = last.data?.[0]?.ts as string | undefined;
    const lag = lastTs ? `${Math.round((Date.now() - new Date(lastTs).getTime()) / 60_000)} min` : '-';
    console.log(`${table.padEnd(16)} ${String(total.count ?? 0).padStart(9)}  ${String(recent.count ?? 0).padStart(9)}  ${(lastTs ?? '-').padEnd(22)} ${lag}`);
  }
  const spool = deadLetterPath();
  if (existsSync(spool)) {
    const lines = readFileSync(spool, 'utf-8').split('\n').filter(Boolean);
    const rows = lines.reduce((n, l) => n + (JSON.parse(l).rows?.length ?? 0), 0);
    console.log(`\ndead-letter spool: ${lines.length} batch(es), ${rows} row(s) at ${spool} — run telemetry:replay`);
  } else {
    console.log('\ndead-letter spool: empty');
  }
}

async function prune(): Promise<void> {
  const turnDays = flag('--turn-days');
  const { data, error } = await supabase.rpc('melchizedek_prune_telemetry', turnDays ? { turn_days: Number(turnDays) } : {});
  if (error) {
    console.error(`prune failed: ${error.message} (is db/telemetry.sql applied?)`);
    process.exit(1);
  }
  const row = Array.isArray(data) ? data[0] : data;
  console.log(`pruned: payloads ${row?.payloads_deleted ?? 0}, turns ${row?.turns_deleted ?? 0}, spans ${row?.spans_deleted ?? 0}`);
}

async function replay(): Promise<void> {
  const spool = deadLetterPath();
  if (!existsSync(spool)) {
    console.log('dead-letter spool is empty');
    return;
  }
  const lines = readFileSync(spool, 'utf-8').split('\n').filter(Boolean);
  const failed: string[] = [];
  let sent = 0;
  for (const line of lines) {
    const batch = JSON.parse(line) as { table: string; rows: unknown[] };
    const { error } = await supabase.from(batch.table).upsert(batch.rows, { onConflict: 'trace_id,span_id', ignoreDuplicates: true });
    if (error) failed.push(line);
    else sent += batch.rows.length;
  }
  renameSync(spool, `${spool}.${Date.now()}.replayed`);
  if (failed.length) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(spool, `${failed.join('\n')}\n`);
  }
  console.log(`replayed ${sent} row(s); ${failed.length} batch(es) still failing${failed.length ? ` (kept in ${spool})` : ''}`);
}

async function embed(): Promise<void> {
  const limit = Number(flag('--limit') ?? 500);
  let total = 0;
  while (total < limit) {
    const batch = Math.min(50, limit - total);
    const { data, error } = await supabase
      .from('adk_turns')
      .select('id,input,output')
      .is('embedding', null)
      .in('stage', ['delegate', 'dispatch'])
      .order('id', { ascending: false })
      .limit(batch);
    if (error) {
      console.error(`embed: ${error.message} (is db/telemetry.sql applied?)`);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ id: number; input: string | null; output: string | null }>;
    if (rows.length === 0) break;
    const vectors = await embedTexts(rows.map((r) => turnEmbeddingText(r.input, r.output)));
    let written = 0;
    for (let i = 0; i < rows.length; i++) {
      if (vectors[i].length === 0) continue;
      const { error: upErr } = await supabase.from('adk_turns').update({ embedding: vectors[i] }).eq('id', rows[i].id);
      if (!upErr) written++;
    }
    total += rows.length;
    console.log(`embedded ${written}/${rows.length} turns (total seen ${total})`);
    if (written === 0) break; // avoid spinning on rows that keep failing
  }
  console.log(total === 0 ? 'nothing to embed' : 'done');
}

switch (command) {
  case 'embed':
    await embed();
    break;
  case 'stats':
    await stats();
    break;
  case 'prune':
    await prune();
    break;
  case 'replay':
    await replay();
    break;
  default:
    console.error(`unknown command '${command}' — stats | prune | replay | embed`);
    process.exit(1);
}
