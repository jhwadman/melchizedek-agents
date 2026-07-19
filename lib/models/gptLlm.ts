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
} from '../tools/webSearchTool.ts';
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
    tools.push({ type: 'web_search' }); // OpenAI-native, runs server-side
  }
  return tools;
}

// ── GptLlm ───────────────────────────────────────────────────────────────────

export class GptLlm extends BaseLlm {
  /** gpt-* and o-series ids route here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [
    /^gpt-.+/,
    /^o[0-9].*/,
  ];

  private apiKey?: string;

  constructor({ model, apiKey }: { model: string; apiKey?: string }) {
    super({ model });
    this.apiKey = apiKey;
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: 'openai', model: this.model },
      this.generateInner(llmRequest, stream),
    );
  }

  private async *generateInner(
    llmRequest: LlmRequest,
    _stream: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const apiKey = this.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      yield {
        errorCode: 'MISSING_API_KEY',
        errorMessage: 'OPENAI_API_KEY is not set in environment.',
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

    const client = new OpenAI({ apiKey });

    const { instructions, input } = buildResponsesInput(llmRequest);
    const tools = buildResponsesTools(llmRequest);
    if (wantsWebSearch(llmRequest)) {
      setLlmSpanAttribute('llm.web_search.native', true);
    }

    const cfg = (llmRequest.config as any) ?? {};
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
      // Reasoning summaries — the model's thinking, when it exposes any.
      ...(isReasoningModel(this.model)
        ? { reasoning: { summary: 'auto' } }
        : {}),
    };

    try {
      let response: any;
      try {
        response = await client.responses.create(request);
      } catch (err: any) {
        // Guarded retry: if the reasoning param is rejected (non-reasoning
        // model matched the pattern), drop it and try once more.
        if (err?.status === 400 && request.reasoning) {
          delete request.reasoning;
          response = await client.responses.create(request);
        } else {
          throw err;
        }
      }

      // Reasoning summaries first, as display-only thought parts.
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { errorCode: 'OPENAI_ERROR', errorMessage: msg };
    }
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
