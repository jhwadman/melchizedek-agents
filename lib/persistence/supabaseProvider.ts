/**
 * lib/persistence/supabaseProvider.ts — Supabase initialization factory.
 *
 * WHY this file exists:
 *   This module encapsulates ALL Supabase-specific concerns:
 *     - Credential detection (reads env vars)
 *     - App initialization
 *     - Service construction (SupabaseSessionService, SupabaseVectorMemoryService)
 */

import type { BaseSessionService, BaseMemoryService } from '@google/adk';
import { isPlaceholderValue } from '../loadEnv.ts';
import type { Embedder, MemoryExtractor } from '../memory/providers.ts';

export interface RlsHardeningStatus {
  /** true only when db/hardening.sql has been applied and RLS is on for both tables. */
  applied: boolean;
  /** Human-readable explanation for logs. */
  detail: string;
}

export interface PersistenceServices {
  sessionService: BaseSessionService;
  memoryService: BaseMemoryService | undefined;
  /**
   * Checks whether the database hardening in db/hardening.sql has been
   * applied (RLS enabled on adk_memory_facts, adk_sessions and — where it
   * exists — adk_agent_registry). Never
   * throws — callers use this to warn operators at boot, not to gate.
   */
  checkRlsHardening: () => Promise<RlsHardeningStatus>;
  /** RPC access for operations that span stores (lib/memory/erase.ts). */
  rpcClient: { rpc: (fn: string, args?: Record<string, unknown>) => any };
}

export interface SupabaseProviderOptions {
  /** The Gemini API key passed to SupabaseVectorMemoryService for embeddings. */
  apiKey: string;
  /** Whether to construct the SupabaseVectorMemoryService (long-term memory). */
  withMemory: boolean;
  /** Fact extractor and embedder for memory (lib/memory/providers.ts).
   *  Default: from the environment (MEMORY_* variables), Gemini when unset. */
  extractor?: MemoryExtractor;
  embedder?: Embedder;
}

/**
 * Returns true if all required Supabase credentials are present in the
 * environment. Does NOT throw — callers use this to decide whether to
 * fall back to in-memory services.
 */
export function hasSupabaseCredentials(): boolean {
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key || isPlaceholderValue(url) || isPlaceholderValue(key)) return false;
  // A value that is not an http(s) URL is a misconfiguration, not credentials:
  // treating it as present crashed supabase-js before the first prompt.
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Initializes the Supabase client and constructs the
 * SupabaseSessionService and optionally the SupabaseVectorMemoryService.
 */
export async function createSupabaseServices(
  options: SupabaseProviderOptions,
): Promise<PersistenceServices> {
  const { createClient } = await import('@supabase/supabase-js');

  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  // ── Session service ────────────────────────────────────────────────────────
  const { SupabaseSessionService } = await import(
    '../session/supabaseSessionService.ts'
  );
  const sessionService = new SupabaseSessionService(supabase);

  // ── Memory service (optional) ──────────────────────────────────────────────
  let memoryService: BaseMemoryService | undefined;
  if (options.withMemory) {
    const { SupabaseVectorMemoryService } = await import(
      '../memory/supabaseMemoryService.ts'
    );
    memoryService = new SupabaseVectorMemoryService(
      { apiKey: options.apiKey, extractor: options.extractor, embedder: options.embedder },
      supabase,
    );
  }

  // ── Hardening probe ─────────────────────────────────────────────────────────
  // Calls the melchizedek_rls_status() function created by db/hardening.sql.
  // If the function is missing, hardening was never run — that is itself the
  // answer, not an error.
  const checkRlsHardening = async (): Promise<RlsHardeningStatus> => {
    try {
      const { data, error } = await supabase.rpc('melchizedek_rls_status');
      if (error) {
        return {
          applied: false,
          detail: 'db/hardening.sql has not been applied (status function missing)',
        };
      }
      const rows = (data ?? []) as { table_name: string; rls_enabled: boolean }[];
      const unprotected = ['adk_memory_facts', 'adk_sessions'].filter(
        (t) => !rows.some((r) => r.table_name === t && r.rls_enabled),
      );
      if (unprotected.length > 0) {
        return {
          applied: false,
          detail: `RLS is disabled on: ${unprotected.join(', ')}`,
        };
      }
      // adk_agent_registry is optional (only deployments that boot
      // `registry:<id>` create it) but NOT advisory: an unprotected registry
      // is agent takeover via the anon key, so a present-and-open table
      // fails the check outright. Absent table => no row => nothing to say.
      const registryRow = rows.find((r) => r.table_name === 'adk_agent_registry');
      if (registryRow && !registryRow.rls_enabled) {
        return {
          applied: false,
          detail:
            'RLS is disabled on: adk_agent_registry (agent definitions are ' +
            'writable with the anon key) — re-run db/hardening.sql',
        };
      }

      // Advisory only — adk_telemetry is optional (db/telemetry.sql). If it
      // exists but hardening.sql wasn't re-run afterwards, say so without
      // failing the check (the mandatory tables are protected).
      const telemetryRow = rows.find((r) => r.table_name === 'adk_telemetry');
      if (telemetryRow && !telemetryRow.rls_enabled) {
        return {
          applied: true,
          detail:
            'RLS enabled on adk_memory_facts and adk_sessions — but NOT on adk_telemetry; re-run db/hardening.sql',
        };
      }
      return { applied: true, detail: 'RLS enabled on adk_memory_facts and adk_sessions' };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { applied: false, detail: `hardening check failed: ${msg}` };
    }
  };

  return { sessionService, memoryService, checkRlsHardening, rpcClient: supabase };
}
