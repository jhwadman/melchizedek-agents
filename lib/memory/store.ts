/**
 * lib/memory/store.ts — where memory facts live (ADR 0021).
 *
 * The memory service (lib/memory/supabaseMemoryService.ts) owns the logic:
 * extraction, dedup, supersession, re-ranked recall. This interface is the
 * five things that logic asks of a database, so the same logic runs over the
 * Supabase REST client or a direct Postgres connection
 * (lib/storage/postgres/memoryStore.ts). Both use the same table and the same
 * `match_memory_facts` function (db/migrations/0001_base.sql).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One row as `match_memory_facts` returns it. */
export interface FactRow {
  id: string;
  user_key: string;
  fact: string;
  tag: string | null;
  fact_date: string | null;
  source: string | null;
  status: string | null;
  keys: string[] | null;
  created_at: string;
  similarity: number;
}

export interface NewFact {
  user_key: string;
  fact: string;
  embedding: number[];
  tag: string;
  fact_date: string | null;
  source: string | null;
  status: string;
  keys: string[];
}

export interface MemoryStore {
  /** Which of `facts` are already stored, byte for byte, under `userKey`. */
  existingFacts(userKey: string, facts: string[]): Promise<Set<string>>;
  /** Nearest facts of one user key by cosine similarity. Throws on failure. */
  match(userKey: string, embedding: number[], count: number): Promise<FactRow[]>;
  /** Inserts the rows; returns each new row's id with its fact. Throws on failure. */
  insert(rows: NewFact[]): Promise<Array<{ id: string; fact: string }>>;
  /** Marks one row superseded by another. Throws on failure. */
  retire(userKey: string, id: string, supersededBy: string): Promise<void>;
  /** Deletes every fact of a user key; returns how many. Throws on failure. */
  deleteUser(userKey: string): Promise<number>;
}

/** The Supabase REST implementation (what the memory service used inline). */
export function supabaseMemoryStore(supabase: SupabaseClient): MemoryStore {
  return {
    async existingFacts(userKey, facts) {
      const { data } = await supabase
        .from('adk_memory_facts')
        .select('fact')
        .eq('user_key', userKey)
        .in('fact', facts);
      return new Set((data ?? []).map((row: { fact: string }) => row.fact));
    },
    async match(userKey, embedding, count) {
      const { data, error } = await supabase.rpc('match_memory_facts', {
        query_embedding: embedding,
        match_count: count,
        filter_user_key: userKey,
      });
      if (error) throw new Error(error.message);
      return (data ?? []) as FactRow[];
    },
    async insert(rows) {
      const { data, error } = await supabase.from('adk_memory_facts').insert(rows).select('id, fact');
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; fact: string }>;
    },
    async retire(userKey, id, supersededBy) {
      const { error } = await supabase
        .from('adk_memory_facts')
        .update({ status: 'superseded', superseded_by: supersededBy })
        .eq('id', id)
        .eq('user_key', userKey);
      if (error) throw new Error(error.message);
    },
    async deleteUser(userKey) {
      const { count, error } = await supabase
        .from('adk_memory_facts')
        .delete({ count: 'exact' })
        .eq('user_key', userKey);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
  };
}

/** True for a Supabase client (as opposed to a MemoryStore). */
export function isSupabaseClient(x: unknown): x is SupabaseClient {
  return !!x && typeof (x as SupabaseClient).from === 'function' && typeof (x as SupabaseClient).rpc === 'function';
}
