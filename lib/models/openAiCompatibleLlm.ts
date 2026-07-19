/**
 * lib/models/openAiCompatibleLlm.ts — shared base class for every provider
 * that speaks the OpenAI chat-completions wire format.
 *
 * WHY this file exists:
 *   Ollama (local, keyless) and xAI Grok both expose /chat/completions
 *   endpoints; the ADK-Content→chat-messages translation, tool-definition
 *   building, tool_call parsing, usage accounting, and reasoning surfacing
 *   are identical between them. Subclasses supply only the endpoint, auth
 *   headers, wire model name, and provider-specific body fields.
 *
 * WHAT THE BASE PROVIDES (uniformly, for every subclass):
 *   - Tool schemas normalized to lowercase JSON-Schema types
 *     (lib/models/schemaNormalize.ts — the ADK/Gemini dialect is uppercase).
 *   - usage → LlmResponse.usageMetadata mapping (prompt_tokens →
 *     promptTokenCount, completion_tokens → candidatesTokenCount,
 *     completion_tokens_details.reasoning_tokens → thoughtsTokenCount),
 *     so traceAgentRun / traceLlmGeneration count tokens for every provider.
 *   - Reasoning ("<think>…</think>" blocks, reasoning_content fields)
 *     surfaced as a { text, thought: true } part in a partial response —
 *     printers display it dimmed; it never enters session history.
 *   - A per-request `llm.request` OpenTelemetry span (lib/observability).
 *   - web_search handling: subclasses with native search return its body
 *     fields from webSearchBodyFields(); those without return null and the
 *     base omits the tool with a one-time warning + span attribute.
 */

import { BaseLlm } from '@google/adk';
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

// ── OpenAI-compatible wire types (the subset these providers implement) ──────

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAiContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Splits "<think>…</think>" scratchpad from the reply. */
export function splitThinkBlocks(text: string): {
  reasoning: string;
  answer: string;
} {
  const blocks: string[] = [];
  const answer = text
    .replace(/<think>([\s\S]*?)<\/think>/g, (_, inner: string) => {
      blocks.push(inner.trim());
      return '';
    })
    .trimStart();
  return { reasoning: blocks.join('\n\n'), answer };
}

// ── OpenAiCompatibleLlm ──────────────────────────────────────────────────────

export abstract class OpenAiCompatibleLlm extends BaseLlm {
  private webSearchWarned = false;

  // ── Subclass surface ───────────────────────────────────────────────────────

  /** Provider id for telemetry, e.g. 'ollama', 'xai'. */
  protected abstract providerId(): string;

  /** Full chat-completions URL, e.g. "https://api.x.ai/v1/chat/completions". */
  protected abstract endpointUrl(): string;

  /** Auth/extra headers. Content-Type is added by the base. */
  protected abstract headers(): Record<string, string>;

  /** Model id as the wire expects it (e.g. strip the "ollama/" namespace). */
  protected wireModelName(): string {
    return this.model;
  }

  /** Provider-specific request body fields (merged last). */
  protected extraBodyFields(_llmRequest: LlmRequest): Record<string, unknown> {
    return {};
  }

  /**
   * Body fields enabling the provider's NATIVE web search, or null when the
   * provider has none (the base then omits the tool and warns once).
   */
  protected webSearchBodyFields(): Record<string, unknown> | null {
    return null;
  }

  /**
   * Extracts reasoning from the response message. Default: "<think>" blocks
   * in content plus the reasoning_content / reasoning fields emitted by
   * OpenAI-compatible reasoning models.
   */
  protected extractReasoning(message: {
    content?: string | null;
    reasoning_content?: string;
    reasoning?: string;
  }): { reasoning: string; answer: string } {
    const { reasoning: thinkReasoning, answer } = splitThinkBlocks(
      message.content ?? '',
    );
    const fieldReasoning = message.reasoning_content ?? message.reasoning ?? '';
    return {
      reasoning: [fieldReasoning, thinkReasoning].filter(Boolean).join('\n\n'),
      answer,
    };
  }

  /** Yielded before the HTTP call when a precondition is missing (e.g. no
   *  API key). Return undefined when ready to call. */
  protected missingRequirement(): LlmResponse | undefined {
    return undefined;
  }

  /** Error response for a non-2xx HTTP status. */
  protected httpError(status: number, detail: string): LlmResponse {
    return {
      errorCode: `${this.providerId().toUpperCase()}_HTTP_ERROR`,
      errorMessage: `${this.providerId()} returned ${status}: ${detail.slice(0, 400)}`,
    };
  }

  /** Error response when the endpoint can't be reached at all. */
  protected unreachable(message: string): LlmResponse {
    return {
      errorCode: `${this.providerId().toUpperCase()}_UNREACHABLE`,
      errorMessage: `Could not reach ${this.endpointUrl()} (${message}).`,
    };
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
    _stream: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const missing = this.missingRequirement();
    if (missing) {
      yield missing;
      return;
    }

    const messages = this.buildMessages(llmRequest);
    const openAiTools = this.buildTools(llmRequest);

    const cfg = (llmRequest.config as any) ?? {};
    const body: Record<string, unknown> = {
      model: this.wireModelName(),
      messages,
      stream: false,
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.topP !== undefined ? { top_p: cfg.topP } : {}),
      ...(cfg.maxOutputTokens !== undefined
        ? { max_tokens: cfg.maxOutputTokens }
        : {}),
      ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
      // critic-style structured output: responseMimeType JSON → json mode
      ...(cfg.responseMimeType === 'application/json'
        ? { response_format: { type: 'json_object' } }
        : {}),
      ...this.extraBodyFields(llmRequest),
    };

    // web_search: enable the provider's native search, or omit with a warning.
    if (wantsWebSearch(llmRequest)) {
      const searchFields = this.webSearchBodyFields();
      if (searchFields) {
        Object.assign(body, searchFields);
        setLlmSpanAttribute('llm.web_search.native', true);
      } else {
        setLlmSpanAttribute('llm.web_search.omitted', true);
        if (!this.webSearchWarned) {
          this.webSearchWarned = true;
          console.warn(
            `⚠ web_search requested but ${this.model} has no native web search — ` +
              'tool omitted (the agent runs without search).',
          );
        }
      }
    }

    try {
      const res = await fetch(this.endpointUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.headers() },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        yield this.httpError(res.status, detail);
        return;
      }

      const data: any = await res.json();
      const message = data.choices?.[0]?.message ?? {};

      const usageMetadata = mapUsage(data.usage);

      const { reasoning, answer } = this.extractReasoning(message);
      if (reasoning) {
        // Scratchpad, not reply: shown by printers, kept out of history.
        yield {
          content: {
            role: 'model',
            parts: [{ text: reasoning, thought: true } as any],
          },
          partial: true,
        };
      }

      const parts: any[] = [];
      if (answer) parts.push({ text: answer });
      for (const call of message.tool_calls ?? []) {
        let args: unknown = {};
        try {
          args = JSON.parse(call.function?.arguments ?? '{}');
        } catch {
          args = { raw: call.function?.arguments };
        }
        parts.push({
          functionCall: {
            name: call.function?.name,
            args,
            id: call.id,
          },
        });
      }

      yield {
        content: { role: 'model', parts },
        turnComplete: true,
        ...(usageMetadata ? { usageMetadata } : {}),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield this.unreachable(msg);
    }
  }

  // ── Translation helpers ────────────────────────────────────────────────────

  /** ADK Contents (Google GenAI format) → OpenAI-compatible chat messages. */
  protected buildMessages(llmRequest: LlmRequest): OpenAiMessage[] {
    const systemParts: string[] = [];
    const messages: OpenAiMessage[] = [];

    for (const content of llmRequest.contents) {
      // ADK injects the system instruction as a 'system' role content.
      if ((content as any).role === 'system') {
        const text = content.parts
          ?.filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('\n');
        if (text) systemParts.push(text);
        continue;
      }

      const isModel = content.role === 'model';
      const textChunks: string[] = [];
      const imageParts: OpenAiContentPart[] = [];
      const toolCalls: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }> = [];

      for (const part of content.parts ?? []) {
        const p = part as any;
        if (p.thought) {
          // Prior-turn scratchpad is display-only; never replay it.
          continue;
        }
        if (p.text) {
          textChunks.push(p.text);
        } else if (p.inlineData?.data) {
          // ADK inline image → OpenAI image_url data URI (vision models)
          const mime = p.inlineData.mimeType ?? 'image/png';
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${p.inlineData.data}` },
          });
        } else if (p.functionCall) {
          // ADK function_call → OpenAI assistant tool_calls entry
          toolCalls.push({
            id: p.functionCall.id ?? `call_${toolCalls.length}`,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args ?? {}),
            },
          });
        } else if (p.functionResponse) {
          // ADK function_response → OpenAI 'tool' role message
          messages.push({
            role: 'tool',
            tool_call_id: p.functionResponse.id ?? '',
            content: JSON.stringify(p.functionResponse.response ?? {}),
          });
        }
      }

      const text = textChunks.join('\n');
      if (isModel) {
        if (text || toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        }
      } else if (text || imageParts.length > 0) {
        messages.push({
          role: 'user',
          content:
            imageParts.length > 0
              ? [...(text ? [{ type: 'text', text } as const] : []), ...imageParts]
              : text,
        });
      }
    }

    // Also pull system instruction from generateContentConfig if present
    const configSystem = (llmRequest.config as any)?.systemInstruction;
    if (configSystem) {
      const text =
        typeof configSystem === 'string'
          ? configSystem
          : configSystem.parts?.map((p: any) => p.text).join('\n') ?? '';
      if (text) systemParts.unshift(text);
    }
    if (systemParts.length > 0) {
      messages.unshift({ role: 'system', content: systemParts.join('\n\n') });
    }

    return messages;
  }

  /** ADK toolsDict → OpenAI function-tool definitions (lowercase schemas). */
  protected buildTools(llmRequest: LlmRequest): unknown[] {
    const openAiTools: unknown[] = [];
    for (const [, tool] of Object.entries(llmRequest.toolsDict ?? {})) {
      if (isWebSearchSentinel(tool)) continue; // handled via body fields
      const t = tool as any;
      if (t.name && t.description) {
        openAiTools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: toLowercaseJsonSchema(
              t.parameters ?? { type: 'object', properties: {} },
            ),
          },
        });
      }
    }
    return openAiTools;
  }

  /**
   * Live/bidirectional streaming — not part of the OpenAI-compatible
   * chat-completions surface. Throws to surface this clearly.
   */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      `${this.constructor.name} does not support live bidirectional connections. ` +
        'Use a Gemini model for live/streaming sessions.',
    );
  }
}

/** OpenAI-style usage → GenAI usageMetadata (undefined when absent). */
export function mapUsage(usage: any):
  | {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
    }
  | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    ...(usage.prompt_tokens !== undefined
      ? { promptTokenCount: usage.prompt_tokens }
      : {}),
    ...(usage.completion_tokens !== undefined
      ? { candidatesTokenCount: usage.completion_tokens }
      : {}),
    ...(reasoning !== undefined ? { thoughtsTokenCount: reasoning } : {}),
    ...(usage.total_tokens !== undefined
      ? { totalTokenCount: usage.total_tokens }
      : {}),
  };
}
