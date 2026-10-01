/**
 * lib/storage/postgres/index.ts — every durable store on one Postgres
 * connection (ADR 0021).
 *
 *   const storage = postgresStorage({ connectionString: process.env.DATABASE_URL });
 *   createA2AApp({ ..., storage });
 *
 * Works on any Postgres with pgvector: Supabase through its connection
 * string, RDS, Cloud SQL, AlloyDB, on-premises. Apply the schema first
 * (`npm run db -- apply`, db/migrations/). With this storage plugged in, A2A
 * tasks and conversations are shared by every instance, so the server can run
 * more than one.
 */

import pg from 'pg';
import type { Pool, PoolConfig } from 'pg';

import { SupabaseVectorMemoryService } from '../../memory/supabaseMemoryService.ts';
import type { Embedder, MemoryExtractor } from '../../memory/providers.ts';
import { ERASE_STORES } from '../../memory/erase.ts';
import type { EraseCounts, EraseOptions } from '../../memory/erase.ts';
import { postgresMemoryStore } from './memoryStore.ts';
import { PostgresSessionService } from './sessionService.ts';
import { PostgresTaskStore } from './taskStore.ts';
import type { PostgresTaskStoreOptions } from './taskStore.ts';

export { PostgresSessionService } from './sessionService.ts';
export { PostgresTaskStore } from './taskStore.ts';
export { postgresMemoryStore } from './memoryStore.ts';

export interface PostgresStorageOptions {
  /** A Postgres URL. Ignored when `pool` is given. */
  connectionString?: string;
  /** Use an existing pool (yours to close). */
  pool?: Pool;
  /** Extra pool settings (ssl, max, …). */
  poolConfig?: PoolConfig;
  /** Days conversations and tasks are kept after their last update. Default 7. */
  ttlDays?: number;
  /**
   * Long-term memory. `apiKey` is the Gemini key used when the extractor or
   * embedder is Gemini (the default). Omit `memory` for no memory service.
   */
  memory?: { apiKey?: string; extractor?: MemoryExtractor; embedder?: Embedder };
  /** Owner of an A2A call, for the task store. Default: the SDK's user scope. */
  taskOwner?: PostgresTaskStoreOptions['ownerResolver'];
}

export interface PostgresStorage {
  pool: Pool;
  sessionService: PostgresSessionService;
  memoryService?: SupabaseVectorMemoryService;
  taskStore: (agentId: string) => PostgresTaskStore;
  erase: (scopeKey: string, options?: EraseOptions) => Promise<EraseCounts>;
  /** Closes the pool when this module created it. */
  close: () => Promise<void>;
}

export function postgresStorage(options: PostgresStorageOptions): PostgresStorage {
  const owned = !options.pool;
  const pool =
    options.pool ??
    new pg.Pool({
      connectionString: options.connectionString,
      ...options.poolConfig,
    });
  if (!options.pool && !options.connectionString && !options.poolConfig?.host) {
    throw new Error('postgresStorage needs a connectionString (e.g. DATABASE_URL) or a pool');
  }

  const sessionService = new PostgresSessionService(pool, { ttlDays: options.ttlDays });
  const memoryService = options.memory
    ? new SupabaseVectorMemoryService(
        { apiKey: options.memory.apiKey ?? '', extractor: options.memory.extractor, embedder: options.memory.embedder },
        postgresMemoryStore(pool),
      )
    : undefined;

  return {
    pool,
    sessionService,
    ...(memoryService ? { memoryService } : {}),
    taskStore: (agentId) => new PostgresTaskStore(pool, agentId, { ttlDays: options.ttlDays, ownerResolver: options.taskOwner }),
    async erase(scopeKey, eraseOptions = {}) {
      if (!scopeKey?.trim()) throw new Error('erase: a scope key is required');
      const r = await pool.query('SELECT store, deleted FROM melchizedek_erase_scope($1, $2, $3)', [
        scopeKey,
        eraseOptions.namespace ?? null,
        eraseOptions.includeNested ?? false,
      ]);
      const counts = Object.fromEntries(ERASE_STORES.map((s) => [s, 0])) as EraseCounts;
      for (const row of r.rows) {
        if ((ERASE_STORES as readonly string[]).includes(row.store)) counts[row.store as keyof EraseCounts] = Number(row.deleted);
      }
      return counts;
    },
    async close() {
      if (owned) await pool.end();
    },
  };
}
