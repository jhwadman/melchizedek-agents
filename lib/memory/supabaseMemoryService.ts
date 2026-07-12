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

const FACT_EXTRACTION_PROMPT = `You are a precise fact extraction engine. Your job is to analyze a conversation transcript and extract discrete, self-contained facts that would be valuable to recall in future conversations.

Rules:
1. Extract ONLY factual information — preferences, decisions, names, dates, technical details, action items, conclusions reached.
2. Each fact must be self-contained — it should make sense without needing the original conversation context.
3. Prefix each fact with a category tag: [PREFERENCE], [FACT], [DECISION], [ACTION], [CONTEXT], or [INSIGHT].
4. Include the user's identity or reference when relevant (e.g., "The user prefers..." not just "Prefers...").
5. Do NOT include conversational filler, greetings, or meta-commentary about the conversation itself.
6. Do NOT fabricate or infer facts that are not explicitly present in the transcript.
7. If the conversation contains no extractable facts, respond with exactly: NO_FACTS_EXTRACTED
8. Return one fact per line. No numbering, no bullet points — just the tagged fact text.

Example output:
[PREFERENCE] The user prefers concise, bulleted responses over long paragraphs.
[FACT] The user's project is called Melchizedek V2, built on the Google ADK framework.
[DECISION] The team decided to use Supabase for session persistence instead of Firestore.
[ACTION] The user needs to provision a pgvector extension in Supabase.
[CONTEXT] The user is building a CLI-first AI orchestration framework with hierarchical agent delegation.
[INSIGHT] The user values latency optimization and transparency of the ADK event stream above all else.

Now extract facts from the following conversation transcript:

---
{transcript}
---`;

export class SupabaseVectorMemoryService implements BaseMemoryService {
	private genai: GoogleGenAI;
	private supabase: SupabaseClient;

	constructor(config: { apiKey: string }, supabaseClient: SupabaseClient) {
		this.genai = new GoogleGenAI({ apiKey: config.apiKey });
		this.supabase = supabaseClient;
		console.log(`[MemoryService] Initialized — backend: Supabase Vector Search (pgvector)`);
	}

	async addSessionToMemory(session: Session): Promise<void> {
		const transcript = this.serializeSession(session);
		if (!transcript.trim()) {
			console.log(`[MemoryService] Session ${session.id} has no content — skipping ingestion.`);
			return;
		}

		console.log(`[MemoryService] Extracting facts from session: ${session.id}`);

		const facts = await this.extractFacts(transcript);
		if (facts.length === 0) {
			console.log(`[MemoryService] No facts extracted from session ${session.id}.`);
			return;
		}
		console.log(`[MemoryService] Extracted ${facts.length} fact(s) from session ${session.id}.`);

		const embeddings = await this.embedTexts(facts);

		const userKey = `${session.appName}/${session.userId}`;

		await this.upsertToSupabase(userKey, facts, embeddings);

		console.log(`[MemoryService] Stored ${facts.length} fact(s) for user key: ${userKey}`);
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

	private async extractFacts(transcript: string): Promise<string[]> {
		const prompt = FACT_EXTRACTION_PROMPT.replace('{transcript}', transcript);
		try {
			const response = await this.genai.models.generateContent({
				model: MEMORY_EXTRACTION_MODEL,
				contents: [{ role: 'user', parts: [{ text: prompt }] }],
				config: {
					temperature: 0.1,
					maxOutputTokens: 2048,
				}
			});

			const text = response.text?.trim() ?? '';
			if (!text || text === 'NO_FACTS_EXTRACTED') return [];

			return text
				.split('\n')
				.map(line => line.trim())
				.filter(line => line.length > 0 && line.startsWith('['));
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[MemoryService] Fact extraction failed: ${msg}`);
			return [];
		}
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

	private async upsertToSupabase(
		userKey: string,
		facts: string[],
		embeddings: number[][]
	): Promise<void> {
		// Dedupe against facts already stored for this user. Stateless callers
		// (the A2A server) ingest after every task, re-serializing the whole
		// session each time — without this check, every multi-turn conversation
		// would store its earlier facts once per turn.
		const { data: existing } = await this.supabase
			.from('adk_memory_facts')
			.select('fact')
			.eq('user_key', userKey)
			.in('fact', facts);
		const known = new Set((existing ?? []).map((row) => row.fact));

		const payload = facts.map((fact, i) => {
			if (embeddings[i].length === 0 || known.has(fact)) return null;
			return {
				user_key: userKey,
				fact,
				embedding: embeddings[i],
			};
		}).filter(item => item !== null);

		if (payload.length === 0) return;

		const { error } = await this.supabase
			.from('adk_memory_facts')
			.insert(payload);

		if (error) {
			console.error(`[MemoryService] Failed to upsert to Supabase:`, error.message);
		}
	}

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
				match_count: 10,
				filter_user_key: userKey,
			});

			if (error) {
				console.error(`[MemoryService] Failed to query Supabase Vector Search:`, error.message);
				return { memories: [] };
			}

			const memories: MemoryEntry[] = [];
			(data || []).forEach((row: any) => {
				memories.push({
					content: { role: 'user', parts: [{ text: row.fact }] } as Content,
					author: 'memory_service',
					timestamp: row.timestamp || new Date().toISOString()
				});
			});

			console.log(`[MemoryService] Found ${memories.length} relevant memories (Supabase pgvector).`);
			return { memories };
		} catch (error: any) {
			console.error(`[MemoryService] Exception calling Supabase Vector Search:`, error.message);
			return { memories: [] };
		}
	}
}
