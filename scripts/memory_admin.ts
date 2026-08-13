/**
 * memory_admin — inspect and hand-clear individual long-term memory records.
 *
 * The store had two blunt instruments and nothing in between: `db:purge`
 * wipes every silo and every session, and `DELETE /memory` erases one silo
 * whole. Neither helps when six copies of one balance are crowding the ten
 * slots recall actually returns. This is the per-record tool.
 *
 * WHY DELETE AND NOT `status='superseded'`: retiring a row does NOT remove it
 * from recall. `match_memory_facts` selects on `user_key` alone — status is
 * applied afterwards in the re-rank, where an active row gets +0.05 and a
 * retired one is merely relabelled. A junk record marked superseded still
 * consumes a candidate slot. Cleaning up means deleting.
 *
 *   npm run memory -- list                              # every silo, with counts
 *   npm run memory -- list --silo <key>                 # the records in one silo
 *   npm run memory -- list --silo <key> --dupes         # group likely restatements
 *   npm run memory -- delete --silo <key> <id> [<id>…]  # DRY RUN — prints what would go
 *   npm run memory -- delete --silo <key> <id> --yes    # actually delete
 *   npm run memory -- delete --silo <key> --all --yes   # erase one silo
 *
 * Ids may be given as the short 8-character prefix shown by `list`. A prefix
 * matching more than one record is refused rather than guessed.
 *
 * Every destructive call is scoped to `--silo` in the WHERE clause as well as
 * by id, so a mistyped id can never reach into another user's memory.
 */
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from '../lib/loadEnv.ts';

loadEnv(import.meta.url);

interface FactRow {
	id: string;
	user_key: string;
	tag: string | null;
	fact: string | null;
	fact_date: string | null;
	status: string | null;
	created_at: string | null;
}

const TABLE = 'adk_memory_facts';

function client(): SupabaseClient {
	const url = process.env.SUPABASE_URL;
	const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
	if (!url || !key) {
		console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
		process.exit(1);
	}
	return createClient(url, key);
}

/** Flag value: `--silo foo` or `--silo=foo`. */
function flag(argv: string[], name: string): string | undefined {
	const eq = argv.find(a => a.startsWith(`--${name}=`));
	if (eq) return eq.slice(name.length + 3);
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
}

/** The record text without its `[TAG | date: … ]` header. */
function body(fact: string | null): string {
	return (fact ?? '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
}

function short(id: string): string {
	return id.slice(0, 8);
}

/**
 * Word-overlap similarity — deliberately NOT the embedding similarity the
 * service uses at write time. This runs offline against text already on the
 * screen, and its only job is to put likely restatements next to each other
 * so a human can judge them. Nothing is deleted on its say-so.
 */
function overlap(a: string, b: string): number {
	const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 2));
	const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 2));
	if (wa.size === 0 || wb.size === 0) return 0;
	let shared = 0;
	for (const w of wa) if (wb.has(w)) shared++;
	return shared / Math.max(wa.size, wb.size);
}

const DUPE_THRESHOLD = 0.6;

async function listSilos(db: SupabaseClient): Promise<void> {
	const { data, error } = await db.from(TABLE).select('user_key, created_at');
	if (error) {
		console.error(`Query failed: ${error.message}`);
		process.exit(1);
	}
	const rows = (data ?? []) as FactRow[];
	if (rows.length === 0) {
		console.log('No memory records stored.');
		return;
	}
	const silos = new Map<string, { n: number; first: string; last: string }>();
	for (const r of rows) {
		const day = (r.created_at ?? '').slice(0, 10);
		const s = silos.get(r.user_key) ?? { n: 0, first: day, last: day };
		s.n++;
		if (day && day < s.first) s.first = day;
		if (day && day > s.last) s.last = day;
		silos.set(r.user_key, s);
	}
	console.log(`${rows.length} record(s) across ${silos.size} silo(s):\n`);
	for (const [key, s] of [...silos.entries()].sort((a, b) => b[1].n - a[1].n)) {
		console.log(`  ${String(s.n).padStart(4)} rows  ${s.first}..${s.last}  ${key}`);
	}
	console.log('\nInspect one:  npm run memory -- list --silo "<key>"');
}

async function listSilo(db: SupabaseClient, silo: string, dupes: boolean): Promise<void> {
	const { data, error } = await db
		.from(TABLE)
		.select('id, user_key, tag, fact, fact_date, status, created_at')
		.eq('user_key', silo)
		.order('created_at', { ascending: true });
	if (error) {
		console.error(`Query failed: ${error.message}`);
		process.exit(1);
	}
	const rows = (data ?? []) as FactRow[];
	if (rows.length === 0) {
		console.log(`No records in silo "${silo}".`);
		return;
	}

	// Cluster labels are assigned only when --dupes is requested, so the plain
	// listing stays a plain listing.
	const cluster = new Map<string, string>();
	if (dupes) {
		const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
		let next = 0;
		for (let i = 0; i < rows.length; i++) {
			if (cluster.has(rows[i].id)) continue;
			const members: string[] = [];
			for (let j = i + 1; j < rows.length; j++) {
				if (cluster.has(rows[j].id)) continue;
				if (rows[i].tag !== rows[j].tag) continue;
				if (overlap(body(rows[i].fact), body(rows[j].fact)) >= DUPE_THRESHOLD) {
					members.push(rows[j].id);
				}
			}
			if (members.length > 0) {
				const label = letters[next % letters.length];
				next++;
				cluster.set(rows[i].id, label);
				for (const id of members) cluster.set(id, label);
			}
		}
	}

	console.log(`${rows.length} record(s) in ${silo}\n`);
	for (const r of rows) {
		const mark = dupes ? `${(cluster.get(r.id) ?? ' ').padEnd(2)}` : '';
		const retired = (r.status ?? 'active') !== 'active' ? ' (retired)' : '';
		console.log(`  ${short(r.id)}  ${mark}${(r.tag ?? '?').padEnd(11)}${(r.fact_date ?? '—').padEnd(11)}${body(r.fact).slice(0, 92)}${retired}`);
	}

	if (dupes) {
		const grouped = [...cluster.values()].length;
		console.log(grouped > 0
			? `\n${grouped} record(s) fall into ${new Set(cluster.values()).size} likely-restatement group(s), marked by letter.`
			: '\nNo likely restatements found.');
		console.log('Groups are a reading aid on word overlap — read them before deleting anything.');
	}
	console.log(`\nDelete:  npm run memory -- delete --silo "${silo}" ${short(rows[0].id)} [more ids…]`);
}

async function remove(db: SupabaseClient, silo: string, argv: string[]): Promise<void> {
	const confirmed = argv.includes('--yes');
	const all = argv.includes('--all');
	const prefixes = argv.slice(argv.indexOf('delete') + 1)
		.filter(a => !a.startsWith('--') && a !== silo);

	if (!all && prefixes.length === 0) {
		console.error('Nothing to delete. Give one or more ids, or --all to erase the silo.');
		process.exit(1);
	}

	const { data, error } = await db
		.from(TABLE)
		.select('id, user_key, tag, fact, fact_date, status, created_at')
		.eq('user_key', silo);
	if (error) {
		console.error(`Query failed: ${error.message}`);
		process.exit(1);
	}
	const rows = (data ?? []) as FactRow[];

	let targets: FactRow[];
	if (all) {
		targets = rows;
	} else {
		targets = [];
		for (const p of prefixes) {
			const matches = rows.filter(r => r.id.startsWith(p));
			if (matches.length === 0) {
				console.error(`No record in this silo starts with "${p}".`);
				process.exit(1);
			}
			if (matches.length > 1) {
				console.error(`"${p}" matches ${matches.length} records — use more characters.`);
				process.exit(1);
			}
			if (!targets.some(t => t.id === matches[0].id)) targets.push(matches[0]);
		}
	}

	if (targets.length === 0) {
		console.log(`Nothing to delete in "${silo}".`);
		return;
	}

	console.log(`${confirmed ? 'Deleting' : 'WOULD DELETE'} ${targets.length} record(s) from ${silo}:\n`);
	for (const t of targets) {
		console.log(`  ${short(t.id)}  ${(t.tag ?? '?').padEnd(11)}${body(t.fact).slice(0, 96)}`);
	}

	if (!confirmed) {
		console.log('\nDry run — nothing was changed. Re-run with --yes to delete.');
		return;
	}

	// Scoped by silo AND id: a mistyped id cannot reach another user's memory.
	const { error: delError, count } = await db
		.from(TABLE)
		.delete({ count: 'exact' })
		.eq('user_key', silo)
		.in('id', targets.map(t => t.id));

	if (delError) {
		console.error(`\nDelete failed: ${delError.message}`);
		process.exit(1);
	}
	console.log(`\nDeleted ${count ?? 0} record(s). This is not reversible.`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command = argv[0] ?? 'list';
	const silo = flag(argv, 'silo');
	const db = client();

	if (command === 'list') {
		if (silo) await listSilo(db, silo, argv.includes('--dupes'));
		else await listSilos(db);
		return;
	}
	if (command === 'delete') {
		if (!silo) {
			console.error('delete requires --silo "<key>". Run `list` to see the silos.');
			process.exit(1);
		}
		await remove(db, silo, argv);
		return;
	}
	console.error(`Unknown command "${command}". Use: list | delete`);
	process.exit(1);
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
