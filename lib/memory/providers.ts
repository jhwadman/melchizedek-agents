/**
 * lib/memory/providers.ts — what computes long-term memory (ADR 0020).
 *
 * WHY this file exists:
 *   Fact extraction and embeddings were hard-wired to Gemini on the server's
 *   own key, outside the model registry and outside the ledger. A deployment
 *   approved for one non-Google provider still sent its transcripts to
 *   Google, and the operator's memory spend never appeared in adk_telemetry.
 *   Both are now small interfaces with the old behaviour as the default:
 *
 *     MemoryExtractor  — any model id, through the same adapters the agents
 *                        use (lib/models/registry.ts resolveModel), so it
 *                        gets every provider, the gateway, and the uniform
 *                        llm.request span for free.
 *     Embedder         — Gemini, or any OpenAI-compatible /embeddings
 *                        endpoint (OpenAI, Ollama, Azure, an internal proxy).
 *
 * Both THROW on failure. The memory service relies on that: a failed call
 * leaves the turns pending for the next ingestion instead of losing them.
 *
 * Configuration (environment; every variable optional):
 *   MEMORY_EXTRACTION_MODEL       model id for extraction (default lib/config.ts)
 *   MEMORY_EMBEDDING_PROVIDER     gemini (default) | openai | ollama | openai-compatible
 *   MEMORY_EMBEDDING_MODEL        default per provider (below)
 *   MEMORY_EMBEDDING_DIMENSIONS   default lib/config.ts EMBEDDING_DIMENSIONS
 *   MEMORY_EMBEDDING_BASE_URL     openai-compatible (required) / ollama override
 *   MEMORY_EMBEDDING_API_KEY      openai-compatible key (else none)
 * The vector column is fixed at creation (db/), so changing the model or the
 * dimension needs a re-embed, not just a new variable.
 */

import { GoogleGenAI } from '@google/genai';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, MEMORY_EXTRACTION_MODEL } from '../config.ts';
import { providerForModel } from '../models/providerMap.ts';
import { resolveModel } from '../models/registry.ts';
import { initializeTracing } from '../observability/tracer.ts';

// ── Interfaces ───────────────────────────────────────────────────────────────

export interface MemoryExtractor {
  /** The model id, for logs and the ledger. */
  readonly model: string;
  /** Runs the extraction prompt; returns the model's text. Throws on failure. */
  extract(prompt: string): Promise<string>;
}

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  /** Vector length every call returns; checked against each result. */
  readonly dimensions: number;
  /** One vector per text, in order. Throws on any failure or wrong length. */
  embed(texts: string[]): Promise<number[][]>;
}

// ── Extraction through the model registry ────────────────────────────────────

export interface ModelExtractorOptions {
  model?: string;
  /** A key for the extraction model's own provider (e.g. the server's Gemini key). */
  apiKey?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Test seam: produce the adapter. Default lib/models/registry.ts resolveModel. */
  resolve?: (model: string, apiKey?: string) => { generateContentAsync(req: LlmRequest, stream?: boolean): AsyncGenerator<LlmResponse, void> };
}

/**
 * Extraction on any model id. The key passed here reaches only a model of
 * the matching provider (resolveModel's BYOK rule); other providers read
 * their own key from the environment, exactly like an agent would.
 */
export function modelExtractor(opts: ModelExtractorOptions = {}): MemoryExtractor {
  const model = opts.model ?? MEMORY_EXTRACTION_MODEL;
  const resolve =
    opts.resolve ??
    ((m: string, apiKey?: string) =>
      resolveModel(m, apiKey ? { apiKey, defaultProvider: providerForModel(m) } : {}));
  return {
    model,
    async extract(prompt: string): Promise<string> {
      const llm = resolve(model, opts.apiKey);
      const request = {
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: { temperature: opts.temperature ?? 0.1, maxOutputTokens: opts.maxOutputTokens ?? 4096 },
        liveConnectConfig: {},
        toolsDict: {},
      } as unknown as LlmRequest;
      let text = '';
      for await (const response of llm.generateContentAsync(request, false)) {
        if (response.errorCode) {
          throw new Error(`${model}: ${response.errorCode}${response.errorMessage ? ` — ${response.errorMessage}` : ''}`);
        }
        if (response.partial) continue;
        for (const part of response.content?.parts ?? []) {
          if (part.text && !(part as { thought?: boolean }).thought) text += part.text;
        }
      }
      return text;
    },
  };
}

// ── Embedders ────────────────────────────────────────────────────────────────

/**
 * One `llm.request` span per embedding batch, so the operator's memory spend
 * lands in the ledger beside every other model call. It is not charged to a
 * turn's step budget: ingestion runs after the turn, and an embedding is not
 * a reasoning step.
 */
async function traced<T>(provider: string, model: string, count: number, fn: () => Promise<T>): Promise<T> {
  initializeTracing();
  const span = trace.getTracer('melchizedek-tracer').startSpan('llm.request');
  span.setAttribute('llm.provider', provider);
  span.setAttribute('llm.model', model);
  span.setAttribute('llm.purpose', 'memory_embedding');
  span.setAttribute('gen_ai.system', provider);
  span.setAttribute('gen_ai.request.model', model);
  span.setAttribute('gen_ai.operation.name', 'embeddings');
  span.setAttribute('llm.embedding.inputs', count);
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    span.setAttribute('llm.error_message', message);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    throw err;
  } finally {
    span.end();
  }
}

function checkLength(vector: number[], dimensions: number, model: string): number[] {
  if (vector.length === 0) throw new Error(`${model} returned an empty embedding`);
  if (vector.length !== dimensions) {
    throw new Error(
      `${model} returned ${vector.length} dimensions, but memory is configured for ${dimensions} ` +
        '(MEMORY_EMBEDDING_DIMENSIONS, and the vector column it was created with)',
    );
  }
  return vector;
}

export function geminiEmbedder(opts: { apiKey: string; model?: string; dimensions?: number }): Embedder {
  const model = opts.model ?? EMBEDDING_MODEL;
  const dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
  const genai = new GoogleGenAI({ apiKey: opts.apiKey });
  return {
    provider: 'gemini',
    model,
    dimensions,
    embed: (texts) =>
      traced('gemini', model, texts.length, async () => {
        const out: number[][] = [];
        for (const text of texts) {
          const response = await genai.models.embedContent({
            model,
            contents: text,
            config: { outputDimensionality: dimensions },
          });
          out.push(checkLength(response.embeddings?.[0]?.values ?? [], dimensions, model));
        }
        return out;
      }),
  };
}

/**
 * Any endpoint speaking OpenAI's POST /embeddings: OpenAI itself, Ollama's
 * /v1, Azure-style proxies, LiteLLM, an internal gateway. `dimensions` is
 * sent for models that can shorten their output (text-embedding-3-*);
 * a model that cannot must already produce that length.
 */
export function openAiCompatibleEmbedder(opts: {
  provider?: string;
  baseUrl: string;
  model: string;
  dimensions?: number;
  apiKey?: string;
  /** Send `dimensions` in the request (default true). Ollama ignores it. */
  sendDimensions?: boolean;
}): Embedder {
  const dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
  const provider = opts.provider ?? 'openai-compatible';
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/embeddings`;
  return {
    provider,
    model: opts.model,
    dimensions,
    embed: (texts) =>
      traced(provider, opts.model, texts.length, async () => {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: opts.model,
            input: texts,
            ...(opts.sendDimensions === false ? {} : { dimensions }),
          }),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          throw new Error(`${provider} embeddings returned ${res.status}${detail ? `: ${detail}` : ''}`);
        }
        const json = (await res.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
        const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (rows.length !== texts.length) {
          throw new Error(`${provider} embeddings returned ${rows.length} vectors for ${texts.length} inputs`);
        }
        return rows.map((r) => checkLength(r.embedding ?? [], dimensions, opts.model));
      }),
  };
}

// ── From the environment ─────────────────────────────────────────────────────

export const DEFAULT_EMBEDDING_MODELS = {
  gemini: EMBEDDING_MODEL,
  openai: 'text-embedding-3-small',
  ollama: 'nomic-embed-text',
} as const;

export interface MemoryProviders {
  extractor: MemoryExtractor;
  embedder: Embedder;
}

/**
 * The deployment's extractor and embedder. `geminiKey` is the key the server
 * already passes for memory; it is used only when the configured extraction
 * model or embedder is Gemini.
 */
export function memoryProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  geminiKey?: string,
): MemoryProviders {
  const extractionModel = env.MEMORY_EXTRACTION_MODEL?.trim() || MEMORY_EXTRACTION_MODEL;
  const extractor = modelExtractor({
    model: extractionModel,
    ...(geminiKey && providerForModel(extractionModel) === 'gemini' ? { apiKey: geminiKey } : {}),
  });

  const provider = (env.MEMORY_EMBEDDING_PROVIDER?.trim() || 'gemini').toLowerCase();
  const dimensions = env.MEMORY_EMBEDDING_DIMENSIONS ? Number(env.MEMORY_EMBEDDING_DIMENSIONS) : undefined;
  if (dimensions !== undefined && (!Number.isInteger(dimensions) || dimensions <= 0)) {
    throw new Error(`MEMORY_EMBEDDING_DIMENSIONS must be a positive integer, got "${env.MEMORY_EMBEDDING_DIMENSIONS}"`);
  }
  const model = env.MEMORY_EMBEDDING_MODEL?.trim();

  let embedder: Embedder;
  switch (provider) {
    case 'gemini': {
      const apiKey = geminiKey || env.GOOGLE_GENAI_API_KEY || env.GEMINI_API_KEY || '';
      embedder = geminiEmbedder({ apiKey, model, dimensions });
      break;
    }
    case 'openai':
      embedder = openAiCompatibleEmbedder({
        provider: 'openai',
        baseUrl: env.MEMORY_EMBEDDING_BASE_URL?.trim() || 'https://api.openai.com/v1',
        model: model ?? DEFAULT_EMBEDDING_MODELS.openai,
        dimensions,
        apiKey: env.OPENAI_API_KEY,
      });
      break;
    case 'ollama':
      embedder = openAiCompatibleEmbedder({
        provider: 'ollama',
        baseUrl: env.MEMORY_EMBEDDING_BASE_URL?.trim() || 'http://localhost:11434/v1',
        model: model ?? DEFAULT_EMBEDDING_MODELS.ollama,
        dimensions,
        sendDimensions: false,
      });
      break;
    case 'openai-compatible': {
      const baseUrl = env.MEMORY_EMBEDDING_BASE_URL?.trim();
      if (!baseUrl || !model) {
        throw new Error('MEMORY_EMBEDDING_PROVIDER=openai-compatible needs MEMORY_EMBEDDING_BASE_URL and MEMORY_EMBEDDING_MODEL');
      }
      embedder = openAiCompatibleEmbedder({ baseUrl, model, dimensions, apiKey: env.MEMORY_EMBEDDING_API_KEY });
      break;
    }
    default:
      throw new Error(
        `MEMORY_EMBEDDING_PROVIDER "${provider}" is not one of gemini, openai, ollama, openai-compatible`,
      );
  }
  return { extractor, embedder };
}
