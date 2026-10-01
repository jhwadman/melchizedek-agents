/**
 * lib/storage/postgres/memoryStore.ts — memory facts on a direct Postgres
 * connection: the MemoryStore (lib/memory/store.ts) the memory service runs
 * on, over the same table and `match_memory_facts` function the Supabase
 * store uses.
 */

import type { Pool } from 'pg';

import type { FactRow, MemoryStore } from '../../memory/store.ts';

/** pgvector's text form: '[0.1,0.2,…]'. */
export function vectorLiteral(v: number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(',')}]`;
}

export function postgresMemoryStore(pool: Pool): MemoryStore {
  return {
    async existingFacts(userKey, facts) {
      if (facts.length === 0) return new Set();
      const r = await pool.query('SELECT fact FROM adk_memory_facts WHERE user_key = $1 AND fact = ANY($2::text[])', [
        userKey,
        facts,
      ]);
      return new Set(r.rows.map((row) => row.fact as string));
    },

    async match(userKey, embedding, count) {
      const r = await pool.query('SELECT * FROM match_memory_facts($1::vector, $2, $3)', [
        vectorLiteral(embedding),
        userKey,
        count,
      ]);
      return r.rows.map((row) => ({
        ...row,
        id: String(row.id),
        fact_date: row.fact_date instanceof Date ? row.fact_date.toISOString().slice(0, 10) : row.fact_date,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        similarity: Number(row.similarity),
      })) as FactRow[];
    },

    async insert(rows) {
      if (rows.length === 0) return [];
      const values: unknown[] = [];
      const tuples = rows.map((row, i) => {
        const b = i * 8;
        values.push(
          row.user_key,
          row.fact,
          vectorLiteral(row.embedding),
          row.tag,
          row.fact_date,
          row.source,
          row.status,
          row.keys,
        );
        return `($${b + 1}, $${b + 2}, $${b + 3}::vector, $${b + 4}, $${b + 5}::date, $${b + 6}, $${b + 7}, $${b + 8}::text[])`;
      });
      const r = await pool.query(
        `INSERT INTO adk_memory_facts (user_key, fact, embedding, tag, fact_date, source, status, keys)
         VALUES ${tuples.join(', ')}
         RETURNING id, fact`,
        values,
      );
      return r.rows.map((row) => ({ id: String(row.id), fact: row.fact as string }));
    },

    async retire(userKey, id, supersededBy) {
      await pool.query(
        `UPDATE adk_memory_facts SET status = 'superseded', superseded_by = $3, updated_at = now()
          WHERE id = $1 AND user_key = $2`,
        [id, userKey, supersededBy],
      );
    },

    async deleteUser(userKey) {
      const r = await pool.query('DELETE FROM adk_memory_facts WHERE user_key = $1', [userKey]);
      return r.rowCount ?? 0;
    },
  };
}
