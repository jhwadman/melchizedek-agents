/**
 * lib/config.ts — Framework-level configuration constants.
 *
 * WHY this file exists:
 *   Previously, model identifiers were hardcoded inside individual service
 *   files, making them invisible to contributors and impossible to change
 *   without hunting through source.
 *
 *   Centralising them here creates a single, obvious place to:
 *     1. Swap the default inference model used by the A2A server
 *     2. Change summary/extraction model without touching service logic
 *     3. Understand the full set of third-party model dependencies at a glance
 *
 *   These are intentionally plain constants — not env vars — because model
 *   IDs are code decisions, not deployment secrets. If you want env-var
 *   overrides, wrap the const: `process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL`.
 */

// ── Inference Models ──────────────────────────────────────────────────────────

/**
 * Default Gemini model used by the A2A server when no model is specified
 * in the caller's YAML or request.
 *
 * Use gemini-3.1-flash-lite for lightweight/cost-efficient loads (subagents,
 * data retrieval). Use gemini-3.5-flash in YAML for production orchestrators.
 *
 * NOTE: gemini-2.5-flash is known incompatible with this framework's
 * includeServerSideToolInvocations flag on AI Studio Tier 1 — do not use it
 * as the default. See DOCUMENTATION.md §7.0 for the full compatibility table.
 *
 * Supported Gemini identifiers: https://ai.google.dev/gemini-api/docs/models
 */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite';

/**
 * Default Claude model used by the A2A server when a claude-* model is
 * requested but no specific identifier is provided.
 *
 * Requires ANTHROPIC_API_KEY to be set. The ClaudeLlm provider in
 * lib/models/claudeLlm.ts handles routing automatically via LLMRegistry.
 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-6';

/**
 * Model used by SupabaseVectorMemoryService to extract discrete facts
 * from a session transcript before embedding them.
 *
 * Must be a text generation model (not an embedding model).
 */
export const MEMORY_EXTRACTION_MODEL = 'gemini-3.5-flash';

// ── Embedding Models ──────────────────────────────────────────────────────────

/**
 * Model used by SupabaseVectorMemoryService to produce vector embeddings
 * for semantic memory storage and retrieval.
 *
 * ⚠ IMPORTANT CONSTRAINT: The output dimensionality set below MUST match the
 * dimensionality of the Supabase pgvector index you have provisioned. The index
 * is created once and cannot be resized. The default (768) fits within
 * Supabase's free-tier limits and is compatible with the match_memory_facts
 * RPC defined in the database schema.
 *
 * If you switch embedding models, you must:
 *   1. Update EMBEDDING_MODEL to the new model identifier.
 *   2. Update EMBEDDING_DIMENSIONS to match the new model's output.
 *   3. Drop and recreate your adk_memory_facts table and ivfflat index.
 *   4. Re-ingest all existing facts (old vectors are dimensionally incompatible).
 *
 * Gemini options:
 *   'gemini-embedding-001'  → supports outputDimensionality up to 3072
 *   'text-embedding-004'    → supports outputDimensionality up to 768
 */
export const EMBEDDING_MODEL = 'gemini-embedding-001';

/**
 * Output dimensionality for the embedding model.
 * Must match the Supabase pgvector index dimension. Default: 768.
 */
export const EMBEDDING_DIMENSIONS = 768;
