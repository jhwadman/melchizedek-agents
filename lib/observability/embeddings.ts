/**
 * lib/observability/embeddings.ts — embeddings for ledger search.
 *
 * The same model and dimensionality as long-term memory (lib/config.ts), so
 * a query embedded here is comparable to a turn embedded by
 * `npm run telemetry:embed`, and the `match_turns` RPC (db/telemetry.sql)
 * compares apples to apples. Kept out of the exporter on purpose: an API
 * call per turn would put inference on the export path; a job embeds in
 * batches after the fact.
 */

import { GoogleGenAI } from '@google/genai';

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '../config.ts';

const MAX_CHARS = 8_000;

export interface EmbedOptions {
  apiKey?: string;
  /** Characters kept per text (long answers are truncated, not skipped). */
  maxChars?: number;
}

/** Embeds each text; a failed text yields an empty vector rather than a throw. */
export async function embedTexts(texts: string[], options: EmbedOptions = {}): Promise<number[][]> {
  const apiKey = options.apiKey ?? process.env.GOOGLE_GENAI_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GOOGLE_GENAI_API_KEY is required for embeddings');
  const genai = new GoogleGenAI({ apiKey });
  const limit = options.maxChars ?? MAX_CHARS;
  const out: number[][] = [];
  for (const text of texts) {
    const clipped = (text ?? '').slice(0, limit);
    if (!clipped.trim()) {
      out.push([]);
      continue;
    }
    try {
      const response = await genai.models.embedContent({
        model: EMBEDDING_MODEL,
        contents: clipped,
        config: { outputDimensionality: EMBEDDING_DIMENSIONS },
      });
      out.push(response.embeddings?.[0]?.values ?? []);
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
