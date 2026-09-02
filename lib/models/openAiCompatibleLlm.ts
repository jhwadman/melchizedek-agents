/**
 * lib/models/openAiCompatibleLlm.ts — shared base class for every provider
 * that speaks the OpenAI chat-completions wire format.
 *
 * WHY this file exists:
 *   Separates the OpenAI chat-completions wire translation (ADK Content →
 *   chat messages, tool-definition building, tool_call parsing, usage
 *   accounting, reasoning surfacing) from provider specifics, so any
 *   /chat/completions-speaking provider is a small subclass supplying only
 *   the endpoint, auth headers, wire model name, and extra body fields.
 *   Current subclass: Ollama (local, keyless). xAI Grok used to live here
 *   too, but xAI's Agent Tools API is Responses-shaped, so GrokLlm now
 *   subclasses GptLlm instead (see lib/models/grokLlm.ts).
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
import { toLowercaseJsonSchema, toStrictJsonSchema } from './schemaNormalize.ts';

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

const OPEN_THINK = '<think>';
const CLOSE_THINK = '</think>';

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialTagSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (s.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Incremental counterpart to splitThinkBlocks, for the SSE path.
 *
 * WHY a state machine rather than the regex: on a stream the closing
 * `</think>` has usually NOT arrived yet, so the regex matches nothing and
 * the whole scratchpad would be printed as the reply. A tag can also be
 * split mid-delta ("<thi" + "nk>"), so any tail that could still grow into
 * a tag is held back instead of being emitted as answer text.
 *
 * Providers that report reasoning in a discrete field (Ollama's
 * `delta.reasoning`, others' `reasoning_content`) never open a think block
 * and pass straight through this untouched.
 */
export class ThinkStreamSplitter {
  private inThink = false;
  private held = '';

  /** Routes one content delta into reasoning/answer text. */
  push(chunk: string): { reasoning: string; answer: string } {
    let buf = this.held + chunk;
    let reasoning = '';
    let answer = '';

    for (;;) {
      const tag = this.inThink ? CLOSE_THINK : OPEN_THINK;
      const at = buf.indexOf(tag);
      if (at === -1) break;
      if (this.inThink) reasoning += buf.slice(0, at);
      else answer += buf.slice(0, at);
      buf = buf.slice(at + tag.length);
      this.inThink = !this.inThink;
    }

    // Hold back only what could still become the tag we're watching for.
    const pending = this.inThink ? CLOSE_THINK : OPEN_THINK;
    const keep = partialTagSuffix(buf, pending);
    this.held = keep > 0 ? buf.slice(buf.length - keep) : '';
    const emit = keep > 0 ? buf.slice(0, buf.length - keep) : buf;
    if (this.inThink) reasoning += emit;
    else answer += emit;

    return { reasoning, answer };
  }

  /** Releases the held tail; the stream ended, so it was never a tag. */
  flush(): { reasoning: string; answer: string } {
    const rest = this.held;
    this.held = '';
    return this.inThink
      ? { reasoning: rest, answer: '' }
      : { reasoning: '', answer: rest };
  }
}

/** Yields parsed `data:` payloads from an SSE response body. */
async function* sseChunks(res: Response): AsyncGenerator<any> {
  const reader = (res.body as any)?.getReader?.();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // Blank separators and ":" keep-alive comments carry no payload.
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') return;
      try {
        yield JSON.parse(payload);
      } catch {
        /* a chunk that isn't valid JSON is not worth killing the turn for */
      }
    }
  }
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
  /** Whether the endpoint accepts response_format json_schema (strict). */
  protected supportsJsonSchemaFormat(): boolean {
    return true;
  }

  /**
   * Whether the endpoint honors stream_options.include_usage. Without it an
   * SSE turn reports no token counts at all; Ollama and xAI both support it.
   */
  protected supportsStreamUsage(): boolean {
    return true;
  }

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
      errorMessage: `${this.providerId()} returned ${status}: ${detail.slice(0, 4000)}`,
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
      { provider: this.providerId(), model: this.model, llmRequest },
      this.generateInner(llmRequest, stream),
    );
  }

  private async *generateInner(
    llmRequest: LlmRequest,
    stream: boolean,
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
      stream,
      // SSE reports token usage only if asked, in a final choices-less chunk.
      ...(stream && this.supportsStreamUsage()
        ? { stream_options: { include_usage: true } }
        : {}),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.topP !== undefined ? { top_p: cfg.topP } : {}),
      ...(cfg.maxOutputTokens !== undefined
        ? { max_tokens: cfg.maxOutputTokens }
        : {}),
      // Reasoning budget. Qwen3-family models think before answering, and on
      // a constraint-dense prompt they can spend the whole budget doing it
      // and return an empty turn. Ollama's OpenAI-compatible endpoint honors
      // `reasoning_effort` and IGNORES the native `think` field, so this is
      // the only lever on this path. Opt-in per agent; omitted = unchanged.
      ...(cfg.reasoningEffort !== undefined
        ? { reasoning_effort: cfg.reasoningEffort }
        : {}),
      ...(openAiTools.length > 0 ? { tools: openAiTools } : {}),
      // Structured output: an ADK outputSchema becomes a strict json_schema
      // response_format where the endpoint supports it (xAI does; Ollama's
      // OpenAI-compatible endpoint does not, see supportsJsonSchemaFormat),
      // else plain JSON mode.
      ...(cfg.responseSchema && this.supportsJsonSchemaFormat()
        ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: toStrictJsonSchema(cfg.responseSchema) } } }
        : cfg.responseMimeType === 'application/json' || cfg.responseSchema
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

      if (stream) {
        yield* this.streamResponse(res);
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

  /**
   * SSE path: display-only partials as the tokens land, then ONE final
   * non-partial response carrying the complete text, tool calls and usage.
   *
   * WHY the final repeats text already streamed: ADK's runner persists only
   * non-partial events (`if (!event.partial) appendEvent(...)`), so a final
   * without text would show the reply on screen and lose it from session
   * history. Printers therefore skip text on a turnComplete event whose
   * partials they already rendered — see scripts/syndicate_chat.ts.
   *
   * Thinking is deliberately NOT carried on the final: the scratchpad is
   * display-only and stays out of history, which is what keeps it from
   * being replayed to the model on the next turn.
   */
  private async *streamResponse(
    res: Response,
  ): AsyncGenerator<LlmResponse, void> {
    const splitter = new ThinkStreamSplitter();
    const toolCalls = new Map<
      number,
      { id?: string; name?: string; args: string }
    >();
    let answer = '';
    let answerStarted = false;
    let usage: any;

    const partial = (text: string, thought: boolean): LlmResponse => ({
      content: {
        role: 'model',
        parts: [thought ? ({ text, thought: true } as any) : { text }],
      },
      partial: true,
    });

    // The scratchpad is usually trailed by blank lines; the reply must not
    // open with them, but only the FIRST answer text may be trimmed.
    const openAnswer = (text: string): string =>
      answerStarted ? text : text.trimStart();

    for await (const chunk of sseChunks(res)) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Reasoning as a discrete field (Ollama `reasoning`, others
      // `reasoning_content`) — already separated, no tag parsing needed.
      const fieldReasoning: string =
        delta.reasoning ?? delta.reasoning_content ?? '';
      if (fieldReasoning) yield partial(fieldReasoning, true);

      if (typeof delta.content === 'string' && delta.content) {
        const split = splitter.push(delta.content);
        if (split.reasoning) yield partial(split.reasoning, true);
        if (split.answer) {
          const text = openAnswer(split.answer);
          if (text) {
            answerStarted = true;
            answer += text;
            yield partial(text, false);
          }
        }
      }

      // Tool arguments arrive as fragments keyed by index, not whole.
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const acc = toolCalls.get(index) ?? { args: '' };
        if (call.id) acc.id = call.id;
        if (call.function?.name) acc.name = call.function.name;
        if (call.function?.arguments) acc.args += call.function.arguments;
        toolCalls.set(index, acc);
      }
    }

    const tail = splitter.flush();
    if (tail.reasoning) yield partial(tail.reasoning, true);
    if (tail.answer) {
      const text = openAnswer(tail.answer);
      if (text) {
        answer += text;
        yield partial(text, false);
      }
    }

    const parts: any[] = [];
    if (answer) parts.push({ text: answer });
    for (const [, acc] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown = {};
      try {
        args = JSON.parse(acc.args || '{}');
      } catch {
        args = { raw: acc.args };
      }
      parts.push({ functionCall: { name: acc.name, args, id: acc.id } });
    }

    const usageMetadata = mapUsage(usage);
    yield {
      content: { role: 'model', parts },
      turnComplete: true,
      ...(usageMetadata ? { usageMetadata } : {}),
    };
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
