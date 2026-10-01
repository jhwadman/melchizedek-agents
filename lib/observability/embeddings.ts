/**
 * lib/observability/embeddings.ts — embeddings for ledger search.
 *
 * The same embedder as long-term memory (lib/memory/providers.ts), so
 * a query embedded here is comparable to a turn embedded by
 * `npm run telemetry:embed`, and the `match_turns` RPC (db/telemetry.sql)
 * compares apples to apples. Kept out of the exporter on purpose: an API
 * call per turn would put inference on the export path; a job embeds in
 * batches after the fact.
 */

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../config.ts';
import { memoryProvidersFromEnv } from '../memory/providers.ts';
import type { Embedder } from '../memory/providers.ts';

const MAX_CHARS = 8_000;

export interface EmbedOptions {
  /** The Gemini key, when the configured embedder is Gemini (the default). */
  apiKey?: string;
  /** Characters kept per text (long answers are truncated, not skipped). */
  maxChars?: number;
  /** Test seam; default the deployment's memory embedder (lib/memory/providers.ts). */
  embedder?: Embedder;
}

/**
 * Embeds each text with the SAME embedder long-term memory uses, so the two
 * vector columns stay comparable and a deployment that moved memory off
 * Google does not keep sending ledger text there. A failed text yields an
 * empty vector rather than a throw: this is a batch job over stored turns.
 */
export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  let embedder = options.embedder;
  if (!embedder) {
    const apiKey = options.apiKey ?? process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY;
    const provider = (process.env.MEMORY_EMBEDDING_PROVIDER?.trim() || 'gemini').toLowerCase();
    if (provider === 'gemini' && !apiKey) throw new Error('GOOGLE_GENAI_API_KEY is required for Gemini embeddings');
    embedder = memoryProvidersFromEnv(process.env, apiKey).embedder;
  }
  const limit = options.maxChars ?? MAX_CHARS;
  const out: number[][] = [];
  for (const text of texts) {
    const clipped = (text ?? '').slice(0, limit);
    if (!clipped.trim()) {
      out.push([]);
      continue;
    }
    try {
      out.push((await embedder.embed([clipped]))[0] ?? []);
    } catch (err: unknown) {
      console.warn(`[embeddings] failed: ${err instanceof Error ? err.message : String(err)}`);
      out.push([]);
    }
  }
  return out;
}

/** The text a turn is embedded by: the question and the answer, in that order. */
export function turnEmbeddingText(input: string | null | undefined, output: string | null | undefined): string {
  return `${(input ?? '').trim()}\n\n${(output ?? '').trim()}`.trim();
}

export { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL };
