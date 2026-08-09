/**
 * lib/models/gptLlm.ts — OpenAI GPT provider for the ADK LLMRegistry.
 *
 * WHY this file exists:
 *   Model optionality: any agent YAML with model: "gpt-*" (or an o-series
 *   id like "o4-mini") routes here after registration. Unlike Grok/Ollama
 *   this adapter does NOT reuse the chat-completions base class — it speaks
 *   OpenAI's Responses API through the official `openai` SDK, because the
 *   Responses API is where OpenAI exposes reasoning summaries (the model's
 *   thinking, surfaced as { thought: true } parts here) and the first-class
 *   `web_search` tool this framework's web_search abstraction maps to.
 *
 * HOW TO ENABLE:
 *   1. Install the SDK (already in package.json):  npm install
 *   2. Add your API key to .env:  OPENAI_API_KEY=sk-...
 *   3. Set model: "gpt-5-mini" (or any gpt-* / o-series id) in your YAML.
 *   registerAvailableProviders() registers this adapter when the key is set.
 *
 * CONTENT FORMAT TRANSLATION:
 *   ADK Content/Part objects → Responses API `input` items:
 *     user/model text        → { role, content } message items
 *     functionCall part      → { type:'function_call', call_id, name, arguments }
 *     functionResponse part  → { type:'function_call_output', call_id, output }
 *   The call_id round-trip matters: this adapter emits functionCall.id so
 *   ADK echoes it back on the tool response, and the Responses API requires
 *   function_call_output.call_id to match the originating call.
 *
 *   Response `output` items map back:
 *     'reasoning' summary    → { text, thought: true } partial (display-only)
 *     'message' output_text  → text part
 *     'function_call'        → functionCall part
 *   usage.input_tokens / output_tokens / output_tokens_details.reasoning_tokens
 *   → LlmResponse.usageMetadata, so token telemetry works like every provider.
 *
 * STREAMING (ADK stream=true, i.e. RunConfig streamingMode: SSE):
 *   The request is sent with { stream: true }; SSE deltas
 *   (response.output_text.delta / response.reasoning_summary_text.delta)
 *   are yielded as { partial: true } responses — the ADK Runner displays
 *   but does NOT persist partial events — and the terminal
 *   response.completed payload is mapped through the same final-response
 *   translator as the non-streaming path, carrying full content + usage
 *   as the ONE event that lands in the session. Function calls are never
 *   delta-streamed (both OpenAI and xAI deliver them whole).
 */

import { BaseLlm, LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';

import {
  traceLlmGeneration,
  setLlmSpanAttribute,
} from '../observability/tracer.ts';
import {
  wantsWebSearch,
  isWebSearchSentinel,
  xaiWebSearchParamsFromEnv,
} from '../tools/webSearchTool.ts';
import {
  wantsXSearch,
  isXSearchSentinel,
  xSearchParamsFromEnv,
} from '../tools/xSearchTool.ts';
import {
  wantsCollectionsSearch,
  isCollectionsSearchSentinel,
  collectionIdsFromEnv,
  collectionsMaxResultsFromEnv,
} from '../tools/collectionsSearchTool.ts';
import { providerForModel } from './providerMap.ts';
import { toLowercaseJsonSchema } from './schemaNormalize.ts';

/** Reasoning-capable ids: o-series and the gpt-5 family. The reasoning
 *  param is also dropped and retried once on a 400, so a miss here only
 *  costs one extra round trip. */
function isReasoningModel(model: string): boolean {
  return /^o[0-9]/.test(model) || /^gpt-5/.test(model);
}

// ── Request building (exported for offline tests) ────────────────────────────

/** ADK Contents → Responses API `input` items + `instructions` string. */
export function buildResponsesInput(llmRequest: LlmRequest): {
  instructions: string | undefined;
  input: any[];
} {
  const systemParts: string[] = [];
  const input: any[] = [];

  for (const content of llmRequest.contents) {
    if ((content as any).role === 'system') {
      const text = content.parts
        ?.filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('\n');
      if (text) systemParts.push(text);
      continue;
    }

    const role = content.role === 'model' ? 'assistant' : 'user';
    const contentParts: any[] = [];

    for (const part of content.parts ?? []) {
      const p = part as any;
      if (p.thought) {
        // Prior-turn scratchpad is display-only; never replay it.
        continue;
      }
      if (p.text) {
        contentParts.push({
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: p.text,
        });
      } else if (p.inlineData?.data && role === 'user') {
        const mime = p.inlineData.mimeType ?? 'image/png';
        contentParts.push({
          type: 'input_image',
          image_url: `data:${mime};base64,${p.inlineData.data}`,
        });
      } else if (p.functionCall) {
        input.push({
          type: 'function_call',
          call_id: p.functionCall.id ?? `call_${input.length}`,
          name: p.functionCall.name,
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        });
      } else if (p.functionResponse) {
        input.push({
          type: 'function_call_output',
          call_id: p.functionResponse.id ?? '',
          output: JSON.stringify(p.functionResponse.response ?? {}),
        });
      }
    }

    if (contentParts.length > 0) {
      input.push({ role, content: contentParts });
    }
  }

  const configSystem = (llmRequest.config as any)?.systemInstruction;
  if (configSystem) {
    const text =
      typeof configSystem === 'string'
        ? configSystem
        : configSystem.parts?.map((p: any) => p.text).join('\n') ?? '';
    if (text) systemParts.unshift(text);
  }

  return {
    instructions: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    input,
  };
}

/** ADK toolsDict (+ web_search sentinel) → Responses API tool definitions. */
export function buildResponsesTools(llmRequest: LlmRequest): any[] {
  const tools: any[] = [];
  for (const [, tool] of Object.entries(llmRequest.toolsDict ?? {})) {
    if (isWebSearchSentinel(tool)) continue; // added as a native tool below
    if (isXSearchSentinel(tool)) continue;   // added as a native tool below
    if (isCollectionsSearchSentinel(tool)) continue; // added as a native tool below
    const t = tool as any;
    if (t.name && t.description) {
      tools.push({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: toLowercaseJsonSchema(
          t.parameters ?? { type: 'object', properties: {} },
        ),
        strict: false,
      });
    }
  }
  if (wantsWebSearch(llmRequest)) {
    // OpenAI-native, runs server-side. On the xAI path only, optional
    // domain filters ride the tool object (XAI_WEB_SEARCH_* env vars —
    // deployment config, the XAI_COLLECTION_IDS doctrine); xAI's web_search
    // accepts no date bounds (docs.x.ai, 2026-08-08 — from_date/to_date are
    // x_search-only). OpenAI's web_search takes no params and stays bare.
    const xaiParams =
      llmRequest.model && providerForModel(llmRequest.model) === 'xai'
        ? xaiWebSearchParamsFromEnv()
        : {};
    tools.push({ type: 'web_search', ...xaiParams });
  }
  if (wantsXSearch(llmRequest)) {
    // xAI Agent Tools only (sentinel is xai-gated). Optional server-side
    // constraints (date bounds, handle lists) are deployment config from
    // XAI_X_SEARCH_* env vars — the XAI_COLLECTION_IDS doctrine; with none
    // set this is the bare tool it always was.
    tools.push({ type: 'x_search', ...xSearchParamsFromEnv() });
  }
  if (wantsCollectionsSearch(llmRequest)) {
    // xAI Collections ride the OpenAI-compatible `file_search` wire shape;
    // ids are deployment config (XAI_COLLECTION_IDS), never YAML.
    const ids = collectionIdsFromEnv();
    if (ids.length > 0) {
      const max = collectionsMaxResultsFromEnv();
      tools.push({
        type: 'file_search',
        vector_store_ids: ids,
        ...(max !== undefined ? { max_num_results: max } : {}),
      });
    } else {
      console.warn(
        '[collections_search] declared but XAI_COLLECTION_IDS is empty — tool omitted for this request.',
      );
    }
  }
  return tools;
}

// ── Stream-event mapping (exported for offline tests) ────────────────────────

/** Maps one Responses-API SSE event to a displayable delta, or null for
 *  event types that carry none. Function calls are NOT delta-streamed —
 *  both OpenAI and xAI deliver them whole in the final response. */
export function streamEventDelta(
  ev: any,
): { thought: boolean; text: string } | null {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
    return { thought: false, text: ev.delta };
  }
  if (
    ev.type === 'response.reasoning_summary_text.delta' &&
    typeof ev.delta === 'string'
  ) {
    return { thought: true, text: ev.delta };
  }
  return null;
}

// ── GptLlm ───────────────────────────────────────────────────────────────────

export class GptLlm extends BaseLlm {
  /** gpt-* and o-series ids route here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [
    /^gpt-.+/,
    /^o[0-9].*/,
  ];

  protected apiKey?: string;

  constructor({ model, apiKey }: { model: string; apiKey?: string }) {
    super({ model });
    this.apiKey = apiKey;
  }

  // ── Provider hooks ─────────────────────────────────────────────────────────
  // The Responses API surface is spoken by more than one vendor: xAI's Agent
  // Tools API (lib/models/grokLlm.ts) is wire-compatible, so GrokLlm
  // subclasses this adapter and overrides only these hooks.

  /** Provider id for telemetry and error codes. */
  protected providerId(): string {
    return 'openai';
  }

  /** SDK baseURL override; undefined = api.openai.com. */
  protected baseURL(): string | undefined {
    return undefined;
  }

  protected apiKeyFromEnv(): string | undefined {
    return process.env.OPENAI_API_KEY;
  }

  protected missingKeyMessage(): string {
    return 'OPENAI_API_KEY is not set in environment.';
  }

  /** Responses API `reasoning` request param, or undefined to omit it.
   *  Base: reasoning summaries for OpenAI's reasoning-capable ids.
   *  Subclasses override per vendor (GrokLlm pins grok-4.5 to a reasoning
   *  effort). A 400 from a model that rejects the param is retried once
   *  without it — see createWithRetry. */
  protected reasoningParam(): Record<string, unknown> | undefined {
    return isReasoningModel(this.model) ? { summary: 'auto' } : undefined;
  }

  /** Extra options for the OpenAI SDK client constructor. Subclasses
   *  override per vendor (GrokLlm sets a long request timeout, per xAI's
   *  streaming guidance for reasoning models). */
  protected clientOptions(): Record<string, unknown> {
    return {};
  }

  // ── Generation ─────────────────────────────────────────────────────────────

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: this.providerId(), model: this.model },
      this.generateInner(llmRequest, stream),
    );
  }

  private async *generateInner(
    llmRequest: LlmRequest,
    stream: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const apiKey = this.apiKey || this.apiKeyFromEnv();
    if (!apiKey) {
      yield {
        errorCode: 'MISSING_API_KEY',
        errorMessage: this.missingKeyMessage(),
      };
      return;
    }

    // Dynamic import — mirrors claudeLlm.ts, so the framework boots without
    // the openai SDK installed for users of other providers.
    let OpenAI: any;
    try {
      const mod = await import('openai');
      OpenAI = mod.default ?? (mod as any).OpenAI;
    } catch {
      yield {
        errorCode: 'SDK_NOT_INSTALLED',
        errorMessage:
          'The openai package is not installed. Run: npm install openai',
      };
      return;
    }

    const client = new OpenAI({
      apiKey,
      ...(this.baseURL() ? { baseURL: this.baseURL() } : {}),
      ...this.clientOptions(),
    });

    const { instructions, input } = buildResponsesInput(llmRequest);
    const tools = buildResponsesTools(llmRequest);
    if (wantsWebSearch(llmRequest)) {
      setLlmSpanAttribute('llm.web_search.native', true);
    }
    if (wantsCollectionsSearch(llmRequest)) {
      setLlmSpanAttribute(
        collectionIdsFromEnv().length > 0
          ? 'llm.collections_search.native'
          : 'llm.collections_search.omitted',
        true,
      );
    }

    const cfg = (llmRequest.config as any) ?? {};
    const reasoning = this.reasoningParam();
    const request: Record<string, unknown> = {
      model: this.model,
      input,
      ...(instructions ? { instructions } : {}),
      ...(tools.length > 0 ? { tools } : {}),
      ...(cfg.maxOutputTokens !== undefined
        ? { max_output_tokens: cfg.maxOutputTokens }
        : {}),
      ...(cfg.temperature !== undefined && !isReasoningModel(this.model)
        ? { temperature: cfg.temperature }
        : {}),
      // Structured output: outputSchema wins over bare JSON mode.
      ...(cfg.responseSchema
        ? {
            text: {
              format: {
                type: 'json_schema',
                name: 'response',
                schema: toLowercaseJsonSchema(cfg.responseSchema),
              },
            },
          }
        : cfg.responseMimeType === 'application/json'
          ? { text: { format: { type: 'json_object' } } }
          : {}),
      // Reasoning param — summaries and/or vendor effort control (see
      // reasoningParam hook; provider subclasses shape it).
      ...(reasoning ? { reasoning } : {}),
    };

    try {
      if (stream) {
        yield* this.streamResponses(client, request);
        return;
      }
      const response = await this.createWithRetry(client, request);
      yield* this.mapFinalResponse(response);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        errorCode: `${this.providerId().toUpperCase()}_ERROR`,
        errorMessage: msg,
      };
    }
  }

  /** responses.create with the guarded reasoning retry: if the model
   *  rejects the reasoning param with a 400 (a non-reasoning model matched
   *  the pattern), drop it and try once more. */
  private async createWithRetry(
    client: any,
    request: Record<string, unknown>,
  ): Promise<any> {
    try {
      return await client.responses.create(request);
    } catch (err: any) {
      if (err?.status === 400 && request.reasoning) {
        delete request.reasoning;
        return await client.responses.create(request);
      }
      throw err;
    }
  }

  /** Final (non-delta) Response → LlmResponse yields: reasoning summaries
   *  as a display-only thought part, then text/functionCall parts with
   *  usage. Shared by the non-streaming path and the stream finalizer
   *  (which sets skipThoughts — its summaries already streamed as deltas). */
  private *mapFinalResponse(
    response: any,
    opts: { skipThoughts?: boolean } = {},
  ): Generator<LlmResponse> {
    if (!opts.skipThoughts) {
      const reasoningTexts: string[] = [];
      for (const item of response.output ?? []) {
        if (item.type === 'reasoning') {
          for (const s of item.summary ?? []) {
            if (s?.text) reasoningTexts.push(s.text);
          }
        }
      }
      if (reasoningTexts.length > 0) {
        yield {
          content: {
            role: 'model',
            parts: [{ text: reasoningTexts.join('\n\n'), thought: true } as any],
          },
          partial: true,
        };
      }
    }

    const parts: any[] = [];
    for (const item of response.output ?? []) {
      if (item.type === 'message') {
        for (const c of item.content ?? []) {
          if (c.type === 'output_text' && c.text) parts.push({ text: c.text });
        }
      } else if (item.type === 'function_call') {
        let args: unknown = {};
        try {
          args = JSON.parse(item.arguments ?? '{}');
        } catch {
          args = { raw: item.arguments };
        }
        parts.push({
          functionCall: { name: item.name, args, id: item.call_id },
        });
      }
    }

    const usage = response.usage;
    yield {
      content: { role: 'model', parts },
      turnComplete: true,
      ...(usage
        ? {
            usageMetadata: {
              ...(usage.input_tokens !== undefined
                ? { promptTokenCount: usage.input_tokens }
                : {}),
              ...(usage.output_tokens !== undefined
                ? { candidatesTokenCount: usage.output_tokens }
                : {}),
              ...(usage.output_tokens_details?.reasoning_tokens !== undefined
                ? {
                    thoughtsTokenCount:
                      usage.output_tokens_details.reasoning_tokens,
                  }
                : {}),
              ...(usage.total_tokens !== undefined
                ? { totalTokenCount: usage.total_tokens }
                : {}),
            },
          }
        : {}),
    };
  }

  /** SSE streaming: yield displayable DELTAS as { partial: true } responses
   *  (the ADK Runner shows but never persists partials), then map the
   *  terminal response.completed payload through mapFinalResponse — full
   *  content + usage, the ONE event that lands in the session. Usage rides
   *  only the final response so the tracer never double-counts tokens. */
  private async *streamResponses(
    client: any,
    request: Record<string, unknown>,
  ): AsyncGenerator<LlmResponse, void> {
    const events: AsyncIterable<any> = await this.createWithRetry(client, {
      ...request,
      stream: true,
    });

    let finalResponse: any | undefined;
    let streamedThoughts = false;
    const textBuf: string[] = [];
    const thoughtBuf: string[] = [];

    for await (const ev of events) {
      const delta = streamEventDelta(ev);
      if (delta) {
        if (delta.thought) {
          streamedThoughts = true;
          thoughtBuf.push(delta.text);
        } else {
          textBuf.push(delta.text);
        }
        yield {
          content: {
            role: 'model',
            parts: [
              delta.thought
                ? ({ text: delta.text, thought: true } as any)
                : { text: delta.text },
            ],
          },
          partial: true,
        };
        continue;
      }
      if (ev?.type === 'response.completed' && ev.response) {
        finalResponse = ev.response;
      } else if (ev?.type === 'response.failed' || ev?.type === 'error') {
        const msg =
          ev?.response?.error?.message ?? ev?.message ?? 'response stream failed';
        yield {
          errorCode: `${this.providerId().toUpperCase()}_STREAM_ERROR`,
          errorMessage: String(msg),
        };
        return;
      }
    }

    if (finalResponse) {
      yield* this.mapFinalResponse(finalResponse, {
        skipThoughts: streamedThoughts,
      });
      return;
    }

    // Defensive: the stream ended without response.completed — aggregate
    // the buffered deltas so the turn still persists a complete event.
    const parts: any[] = [];
    if (thoughtBuf.length > 0)
      parts.push({ text: thoughtBuf.join(''), thought: true } as any);
    if (textBuf.length > 0) parts.push({ text: textBuf.join('') });
    yield { content: { role: 'model', parts }, turnComplete: true };
  }

  /** Live/bidirectional streaming is not wired for this adapter. */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'GptLlm does not support live bidirectional connections. ' +
        'Use a Gemini model for live/streaming sessions.',
    );
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers GptLlm with the ADK LLMRegistry. Called by
 * registerAvailableProviders() when OPENAI_API_KEY is present.
 */
export function registerGptLlm(): void {
  LLMRegistry.register(GptLlm);
}
