/**
 * lib/memory/erase.ts — erase a scope from every store (ADR 0020 item 7).
 *
 * One call to `melchizedek_erase_scope` (db/migrations/0002_erase_scope.sql),
 * which deletes memory facts, sessions (with the per-subagent rows ADK writes
 * beside them), the ledger's turns, spans, payloads, verdicts and labels, and the
 * scope's durable A2A tasks
 * for those conversations, in one transaction. Returns what each store lost.
 *
 * Throws on any failure: a deletion request that silently did nothing is
 * worse than an error the caller can surface and retry.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const ERASE_STORES = [
  'memory_facts',
  'sessions',
  'turns',
  'spans',
  'payloads',
  'verdicts',
  'labels',
  'tasks',
] as const;
export type EraseStore = (typeof ERASE_STORES)[number];
export type EraseCounts = Record<EraseStore, number>;

export interface EraseOptions {
  /** Erase only this namespace. Default: every namespace. */
  namespace?: string;
  /** Also erase scopes nested beneath this one ('<scopeKey>/...'). */
  includeNested?: boolean;
}

export async function eraseScope(
  client: Pick<SupabaseClient, 'rpc'>,
  scopeKey: string,
  options: EraseOptions = {},
): Promise<EraseCounts> {
  if (!scopeKey?.trim()) throw new Error('eraseScope: a scope key is required');
  const { data, error } = await client.rpc('melchizedek_erase_scope', {
    p_scope_key: scopeKey,
    p_namespace: options.namespace ?? null,
    p_include_nested: options.includeNested ?? false,
  });
  if (error) {
    const missing = /melchizedek_erase_scope|function .* does not exist|PGRST202/i.test(
      `${error.message} ${(error as { code?: string }).code ?? ''}`,
    );
    throw new Error(
      missing
        ? 'Erase is not installed in this database: run `npm run db -- apply` (db/migrations/0002_erase_scope.sql).'
        : `Erase failed for ${scopeKey}: ${error.message}`,
    );
  }
  const counts = Object.fromEntries(ERASE_STORES.map((s) => [s, 0])) as EraseCounts;
  for (const row of (data ?? []) as Array<{ store: string; deleted: number | string }>) {
    if ((ERASE_STORES as readonly string[]).includes(row.store)) {
      counts[row.store as EraseStore] = Number(row.deleted);
    }
  }
  return counts;
}
