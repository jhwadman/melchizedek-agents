import type {
	BaseMemoryService,
	SearchMemoryRequest,
	SearchMemoryResponse,
	MemoryEntry,
	Session,
} from '@google/adk';
import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import type { SupabaseClient } from '@supabase/supabase-js';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, MEMORY_EXTRACTION_MODEL } from '../config.ts';

const FACT_EXTRACTION_PROMPT = `You are a precise record-keeping engine. Your job is to analyze a conversation transcript and distill it into structured, self-contained memory records that can be trusted and evolved in future conversations.

Today's date (the session date) is {session_date}.

OUTPUT FORMAT — one record per line, nothing else:

[TAG | date: YYYY-MM-DD or n/a | source: <who asserted it> | status: active or historical | keys: <1-5 comma-separated index keys>] <the record text>

A record that corrects or replaces an earlier record adds one more header field before the closing bracket:

[CORRECTION | date: ... | source: ... | status: active | keys: ... | supersedes: <short quote of the outdated claim>] <the corrected record text>

TAGS: [FACT], [PREFERENCE], [DECISION], [ACTION], [CONTEXT], [INSIGHT], [CORRECTION], [EPISODE].

RULES:
1. Each record must be self-contained — it must make sense without the original conversation. Include the user's identity or reference when relevant ("The user's father...", not "He...").
2. VALUES KEEP THEIR UNITS, EXACTLY AS STATED: "25 mg twice daily", "1.4 mg/dL", "132/85 mmHg". Never round, convert, or restate a number from your own knowledge.
3. DATES ARE ABSOLUTE: the date field is the date the record is ABOUT (not today, unless it is about today). Convert every relative date using the session date — "last Tuesday" becomes its YYYY-MM-DD. Use n/a only when genuinely undated. Repeat any date inside the record text as YYYY-MM-DD too.
4. SOURCE names who asserted the record: "user", "user's cardiologist Dr. Osei", "discharge orders 2026-07-03", "lab report", "unknown". Never store your own general knowledge as a record — the store holds THIS user's history, not the model's training data.
5. STATUS is "active" for things currently true, "historical" for things explicitly ended, discontinued, or replaced within this same transcript.
6. KEYS are 1-5 lowercase index terms (names, medications, metrics, topics) that connect this record to future questions: "metoprolol, heart rate, dr-osei".
7. CORRECTIONS: when the user corrects or updates something previously established, emit a [CORRECTION] record with a supersedes field quoting the outdated claim, so the store can retire it.
8. CONTRADICTIONS: if the transcript contains an unresolved contradiction, store BOTH records and add one [CONTEXT] record naming the conflict, with "contradiction" among its keys. Never silently pick a side.
9. EPISODE: emit exactly one [EPISODE] record per transcript — a 1-3 sentence narrative of what happened this session (what was discussed, decided, and left open). This is the semantic thread connecting the discrete records.
10. Do NOT store conversational filler, greetings, meta-commentary, or anything the model could re-derive from general knowledge.
11. Do NOT fabricate or infer records not explicitly present in the transcript.
12. If the conversation contains no extractable records, respond with exactly: NO_FACTS_EXTRACTED

Example output:
[FACT | date: 2026-07-03 | source: discharge orders 2026-07-03 | status: active | keys: metoprolol, dosing, cardiac event] The user's father takes metoprolol tartrate 25 mg twice daily, started 2026-07-03 after his cardiac event.
[FACT | date: 2026-07-08 | source: lab report | status: active | keys: creatinine, kidney, labs] The father's creatinine on 2026-07-08 was 1.4 mg/dL, up from 1.1 mg/dL in 2026-05.
[CORRECTION | date: 2026-07-10 | source: user | status: active | keys: metoprolol, dosing | supersedes: metoprolol tartrate 25 mg twice daily] Per the user, the cardiologist raised the father's metoprolol to 50 mg twice daily on 2026-07-10.
[EPISODE | date: {session_date} | source: session | status: active | keys: follow-up, medications] The user reviewed the father's record ahead of Tuesday's cardiology follow-up and updated the metoprolol dose; baseline blood pressure readings are still missing.

Now distill the following conversation transcript:

---
{transcript}
---`;

/** A parsed structured memory record, ready for storage. */
interface MemoryRecord {
	/** The full structured line — this is what gets embedded and stored. */
	line: string;
	tag: string;
	factDate: string | null; // YYYY-MM-DD
	source: string | null;
	status: 'active' | 'historical';
	keys: string[];
	/** Short quote of the outdated claim this record retires, if any. */
	supersedes: string | null;
}

interface FactRow {
	id: string;
	fact: string;
	tag: string | null;
	fact_date: string | null;
	source: string | null;
	status: string | null;
	keys: string[] | null;
	created_at: string | null;
	similarity: number;
}

const RECORD_RE = /^\[([A-Z]+)((?:\s*\|[^\]]*)?)\]\s*(.+)$/;
const MONTH_NAMES = [
	'january', 'february', 'march', 'april', 'may', 'june',
	'july', 'august', 'september', 'october', 'november', 'december',
];

export class SupabaseVectorMemoryService implements BaseMemoryService {
	private genai: GoogleGenAI;
	private supabase: SupabaseClient;

	constructor(config: { apiKey: string }, supabaseClient: SupabaseClient) {
		this.genai = new GoogleGenAI({ apiKey: config.apiKey });
		this.supabase = supabaseClient;
		console.log(`[MemoryService] Initialized — backend: Supabase Vector Search (pgvector), structured records`);
	}

	async addSessionToMemory(session: Session): Promise<void> {
		const transcript = this.serializeSession(session);
		if (!transcript.trim()) {
			console.log(`[MemoryService] Session ${session.id} has no content — skipping ingestion.`);
			return;
		}

		console.log(`[MemoryService] Extracting records from session: ${session.id}`);

		const records = await this.extractRecords(transcript);
		if (records.length === 0) {
			console.log(`[MemoryService] No records extracted from session ${session.id}.`);
			return;
		}
		console.log(`[MemoryService] Extracted ${records.length} record(s) from session ${session.id}.`);

		const embeddings = await this.embedTexts(records.map(r => r.line));

		const userKey = `${session.appName}/${session.userId}`;

		const inserted = await this.upsertToSupabase(userKey, records, embeddings);
		await this.applySupersessions(userKey, records, inserted);

		console.log(`[MemoryService] Stored ${inserted.size} record(s) for user key: ${userKey}`);
	}

	/**
	 * Right-to-erasure: permanently deletes every stored fact for a user key
	 * (`{appName}/{userId}`). Returns the number of rows removed. Throws on
	 * database error so callers can surface the failure — a silent no-op on
	 * a deletion request is unacceptable for user data.
	 *
	 * NOTE: this clears `adk_memory_facts` only. Session transcripts live in
	 * `adk_sessions` and must be cleared separately if full erasure is needed.
	 */
	async deleteUserMemory(userKey: string): Promise<number> {
		const { count, error } = await this.supabase
			.from('adk_memory_facts')
			.delete({ count: 'exact' })
			.eq('user_key', userKey);

		if (error) {
			throw new Error(`Memory deletion failed for ${userKey}: ${error.message}`);
		}

		console.log(`[MemoryService] Deleted ${count ?? 0} fact(s) for user key: ${userKey}`);
		return count ?? 0;
	}

	async searchMemory(request: SearchMemoryRequest): Promise<SearchMemoryResponse> {
		console.log(`[MemoryService] Searching memory for: "${request.query}"`);
		const userKey = `${request.appName}/${request.userId}`;
		return this.searchSupabase(userKey, request.query);
	}

	private async extractRecords(transcript: string): Promise<MemoryRecord[]> {
		const sessionDate = new Date().toISOString().slice(0, 10);
		const prompt = FACT_EXTRACTION_PROMPT
			.replaceAll('{session_date}', sessionDate)
			.replace('{transcript}', transcript);
		try {
			const response = await this.genai.models.generateContent({
				model: MEMORY_EXTRACTION_MODEL,
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				config: {
					temperature: 0.1,
					maxOutputTokens: 4096,
				}
			});

			const text = response.text?.trim() ?? '';
			if (!text || text === 'NO_FACTS_EXTRACTED') return [];

			return text
				.split('\n')
				.map(line => this.parseRecord(line.trim()))
				.filter((r): r is MemoryRecord => r !== null);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[MemoryService] Record extraction failed: ${msg}`);
			return [];
		}
	}

	/**
	 * Parses one structured record line. Lines that don't match the format
	 * are dropped (extraction is best-effort; a malformed line must never
	 * poison the store). Header fields are optional individually — a bare
	 * `[FACT] text` line still parses, with defaults.
	 */
	private parseRecord(line: string): MemoryRecord | null {
		const m = RECORD_RE.exec(line);
		if (!m) return null;

		const [, tag, headerRest, body] = m;
		if (!body.trim()) return null;

		let factDate: string | null = null;
		let source: string | null = null;
		let status: 'active' | 'historical' = 'active';
		let keys: string[] = [];
		let supersedes: string | null = null;

		for (const field of headerRest.split('|')) {
			const idx = field.indexOf(':');
			if (idx === -1) continue;
			const name = field.slice(0, idx).trim().toLowerCase();
			const value = field.slice(idx + 1).trim();
			if (!value) continue;
			switch (name) {
				case 'date':
					if (/^\d{4}-\d{2}-\d{2}$/.test(value)) factDate = value;
					break;
				case 'source':
					source = value;
					break;
				case 'status':
					if (value.toLowerCase() === 'historical') status = 'historical';
					break;
				case 'keys':
					keys = value.split(',').map(k => k.trim().toLowerCase()).filter(k => k.length > 0).slice(0, 8);
					break;
				case 'supersedes':
					supersedes = value;
					break;
			}
		}

		return { line, tag, factDate, source, status, keys, supersedes };
	}

	private async embedTexts(texts: string[]): Promise<number[][]> {
		const embeddings: number[][] = [];
		for (const text of texts) {
			try {
				const response = await this.genai.models.embedContent({
					model: EMBEDDING_MODEL,
					contents: text,
					config: {
						outputDimensionality: EMBEDDING_DIMENSIONS
					}
				});

				if (response.embeddings && response.embeddings.length > 0) {
					embeddings.push(response.embeddings[0].values ?? []);
				} else {
					console.warn(`[MemoryService] Empty embedding returned for: "${text.slice(0, 50)}..."`);
					embeddings.push([]);
				}
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[MemoryService] Embedding failed: ${msg}`);
				embeddings.push([]);
			}
		}
		return embeddings;
	}

	private serializeSession(session: Session): string {
		const lines: string[] = [];
		for (const event of session.events) {
			if (!event.content?.parts) continue;

			const textParts: string[] = [];
			for (const p of event.content.parts) {
				if ('text' in p && typeof p.text === 'string' && p.text.trim().length > 0) {
					textParts.push(p.text);
				}
			}

			if (textParts.length === 0) continue;

			const role = event.author ?? event.content.role ?? 'unknown';
			lines.push(`[${role}]: ${textParts.join(' ')}`);
		}
		return lines.join('\n');
	}

	/**
	 * Inserts new records and returns a map of record line → inserted row id
	 * (needed to link superseded rows to their replacement).
	 */
	private async upsertToSupabase(
		userKey: string,
		records: MemoryRecord[],
		embeddings: number[][]
	): Promise<Map<string, string>> {
		const insertedIds = new Map<string, string>();

		// Dedupe against facts already stored for this user. Stateless callers
		// (the A2A server) ingest after every task, re-serializing the whole
		// session each time — without this check, every multi-turn conversation
		// would store its earlier facts once per turn.
		const { data: existing } = await this.supabase
			.from('adk_memory_facts')
			.select('fact')
			.eq('user_key', userKey)
			.in('fact', records.map(r => r.line));
		const known = new Set((existing ?? []).map((row) => row.fact));

		const payload = records.map((record, i) => {
			if (embeddings[i].length === 0 || known.has(record.line)) return null;
			return {
				user_key: userKey,
				fact: record.line,
				embedding: embeddings[i],
				tag: record.tag,
				fact_date: record.factDate,
				source: record.source,
				status: record.status,
				keys: record.keys,
			};
		}).filter(item => item !== null);

		if (payload.length === 0) return insertedIds;

		const { data, error } = await this.supabase
			.from('adk_memory_facts')
			.insert(payload)
			.select('id, fact');

		if (error) {
			console.error(`[MemoryService] Failed to upsert to Supabase:`, error.message);
			return insertedIds;
		}

		for (const row of data ?? []) {
			insertedIds.set(row.fact, row.id);
		}
		return insertedIds;
	}

	/**
	 * The record evolves: a stored record carrying a `supersedes` header
	 * retires the older rows it corrects. Candidates are found by embedding
	 * the superseded quote and similarity-searching the user's ACTIVE rows;
	 * a candidate is retired when it is both semantically close and shares
	 * an index key with the correction (or is a near-exact match). Retired
	 * rows are kept — marked status='superseded' and linked via
	 * superseded_by — so history and contradictions stay inspectable.
	 */
	private async applySupersessions(
		userKey: string,
		records: MemoryRecord[],
		insertedIds: Map<string, string>
	): Promise<void> {
		const corrections = records.filter(r => r.supersedes && insertedIds.has(r.line));
		if (corrections.length === 0) return;

		const newIds = new Set(insertedIds.values());
		const targetEmbeddings = await this.embedTexts(corrections.map(r => r.supersedes as string));

		for (let i = 0; i < corrections.length; i++) {
			const correction = corrections[i];
			const vec = targetEmbeddings[i];
			if (!vec || vec.length === 0) continue;

			const { data, error } = await this.supabase.rpc('match_memory_facts', {
				query_embedding: vec,
				match_count: 5,
				filter_user_key: userKey,
			});
			if (error) {
				console.error(`[MemoryService] Supersession lookup failed:`, error.message);
				continue;
			}

			const correctionId = insertedIds.get(correction.line) as string;
			for (const row of (data ?? []) as FactRow[]) {
				if (newIds.has(row.id)) continue; // never retire a record from this same ingestion
				if ((row.status ?? 'active') !== 'active') continue;
				const sharesKey = (row.keys ?? []).some(k => correction.keys.includes(k));
				const retire = row.similarity >= 0.85 || (row.similarity >= 0.6 && sharesKey);
				if (!retire) continue;

				const { error: updateError } = await this.supabase
					.from('adk_memory_facts')
					.update({ status: 'superseded', superseded_by: correctionId })
					.eq('id', row.id)
					.eq('user_key', userKey);
				if (updateError) {
					console.error(`[MemoryService] Failed to retire superseded record:`, updateError.message);
				} else {
					console.log(`[MemoryService] Superseded: "${row.fact.slice(0, 60)}..." → ${correctionId}`);
				}
			}
		}
	}

	/**
	 * Hybrid recall: candidates come from pgvector cosine similarity, then
	 * are re-ranked by the query's connection to the record's index keys and
	 * dates. Active records outrank retired ones; retired records that still
	 * surface are relabeled so the model sees them as history, never as the
	 * current state.
	 */
	private async searchSupabase(
		userKey: string,
		query: string
	): Promise<SearchMemoryResponse> {
		const queryEmbeddings = await this.embedTexts([query]);
		const queryVec = queryEmbeddings[0];

		if (!queryVec || queryVec.length === 0) {
			return { memories: [] };
		}

		try {
			// Calls the Postgres RPC function `match_memory_facts` created in Supabase
			const { data, error } = await this.supabase.rpc('match_memory_facts', {
				query_embedding: queryVec,
				match_count: 24,
				filter_user_key: userKey,
			});

			if (error) {
				console.error(`[MemoryService] Failed to query Supabase Vector Search:`, error.message);
				return { memories: [] };
			}

			const q = query.toLowerCase();
			const queryYears: string[] = q.match(/\b20\d{2}\b/g) ?? [];
			const queryMonths = MONTH_NAMES.filter(mn => q.includes(mn));

			const scored = ((data ?? []) as FactRow[]).map(row => {
				let score = row.similarity;
				const status = row.status ?? 'active';

				// Index-key channel: the query names an entity the record is filed under.
				if ((row.keys ?? []).some(k => k.length > 2 && q.includes(k))) score += 0.12;

				// Date channel: the query names a month/year the record is dated to.
				if (row.fact_date) {
					const [year, month] = row.fact_date.split('-');
					if (queryYears.includes(year)) score += 0.08;
					if (queryMonths.includes(MONTH_NAMES[parseInt(month, 10) - 1])) score += 0.1;
				}

				// The current record outranks its retired ancestors.
				if (status === 'active') score += 0.05;

				return { row, score, status };
			}).sort((a, b) => b.score - a.score).slice(0, 10);

			const memories: MemoryEntry[] = scored.map(({ row, status }) => {
				let text = row.fact;
				if (status === 'superseded') {
					// The stored header says "status: active" as of writing; relabel
					// so a retired record can never masquerade as the current state.
					text = text.includes('status: active')
						? text.replace('status: active', 'status: SUPERSEDED by a later correction')
						: `[SUPERSEDED by a later correction] ${text}`;
				}
				return {
					content: { role: 'user', parts: [{ text }] } as Content,
					author: 'memory_service',
					timestamp: row.created_at || new Date().toISOString()
				};
			});

			console.log(`[MemoryService] Found ${memories.length} relevant memories (Supabase pgvector, hybrid re-rank).`);
			return { memories };
		} catch (error: any) {
			console.error(`[MemoryService] Exception calling Supabase Vector Search:`, error.message);
			return { memories: [] };
		}
	}
}
