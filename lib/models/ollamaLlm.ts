/**
 * lib/models/ollamaLlm.ts — open-weight / local model provider for the ADK
 * LLMRegistry, served by Ollama.
 *
 * WHY this file exists:
 *   Every other provider in this framework bills per token and requires an
 *   API key. An open-weight model pulled through Ollama runs on the user's
 *   own machine: no key, no account, no data leaving the device. That makes
 *   it the teaching provider for the lyceumagents.com curriculum's Part 1 —
 *   and a legitimate production choice wherever privacy or cost demands
 *   local inference.
 *
 *   The ADK JS package (@google/adk v1.x) is Gemini-native, but exposes the
 *   same extension point claudeLlm.ts uses: subclass BaseLlm, implement
 *   generateContentAsync(), register via LLMRegistry.register(). Any agent
 *   with model: "ollama/<model>" then routes here automatically.
 *
 * HOW TO ENABLE:
 *   1. Install Ollama (https://ollama.com — macOS: brew install ollama)
 *      and start it (the desktop app, or `ollama serve`).
 *   2. Pull a model that supports tool calling:
 *        ollama pull qwen3:8b        # text + tools
 *        ollama pull qwen3-vl:8b     # text + vision + tools
 *   3. Set model: "ollama/qwen3:8b" in your YAML. No API key needed —
 *      syndicate_chat.ts registers this provider unconditionally.
 *   Optional: OLLAMA_BASE_URL in .env overrides the default endpoint
 *   (http://localhost:11434/v1 — Ollama's OpenAI-compatible API).
 *
 * DESIGN NOTES:
 *   - Zero dependencies: talks to Ollama's OpenAI-compatible endpoint with
 *     the built-in fetch. No SDK to install, nothing to auth.
 *   - The "ollama/" prefix is a routing namespace for the LLMRegistry and is
 *     stripped before the HTTP call (Ollama knows the model as "qwen3:8b").
 *   - Reasoning models (qwen3 family) emit <think>…</think> blocks before
 *     their answer. Those are the model's scratchpad, not its reply, so this
 *     adapter strips them. Stripping needs the complete text, so the
 *     streaming path collects the full response and yields once — local
 *     inference keeps that wait short.
 *   - Vision: ADK inlineData parts (images) are translated to OpenAI
 *     image_url data URIs, so ollama/qwen3-vl:8b can see attached images.
 *
 * LIMITATIONS vs Gemini:
 *   - GOOGLE_SEARCH grounding is Gemini-only. A local agent's grounding is
 *     what you supply: pasted material, subagents, or MCP tools.
 *   - generate_image / inspect_image call Gemini image models directly and
 *     still require a Gemini key regardless of the inference model.
 *   - thinkingConfig is Gemini-only; qwen3 thinks on its own schedule.
 */

import { BaseLlm, LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';
import type { BaseLlmConnection } from '@google/adk';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

// ── OpenAI-compatible wire types (the subset Ollama implements) ──────────────

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

/** The model's scratchpad is not its reply. */
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trimStart();
}

// ── OllamaLlm ─────────────────────────────────────────────────────────────────

export class OllamaLlm extends BaseLlm {
  /**
   * Model ids namespaced "ollama/<model>" route here after registration,
   * e.g. model: "ollama/qwen3:8b" in a syndicate YAML.
   */
  static readonly supportedModels: Array<string | RegExp> = [/^ollama\/.+/];

  private baseUrl: string;

  constructor({ model, baseUrl }: { model: string; baseUrl?: string }) {
    super({ model });
    this.baseUrl =
      baseUrl || process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  }

  /**
   * Main generation method called by the ADK Runner for every turn.
   * Translates ADK's LlmRequest (Google Content format) → OpenAI-compatible
   * chat messages, calls Ollama, and maps the response back to LlmResponse.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    // ── Translate ADK Contents → OpenAI-compatible messages ──────────────────
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

    // ── Build OpenAI tool definitions from ADK toolsDict ─────────────────────
    const openAiTools: any[] = [];
    for (const [, tool] of Object.entries(llmRequest.toolsDict ?? {})) {
      const t = tool as any;
      if (t.name && t.description) {
        openAiTools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters ?? { type: 'object', properties: {} },
          },
        });
      }
    }

    // ── Call Ollama's OpenAI-compatible endpoint ─────────────────────────────
    const cfg = (llmRequest.config as any) ?? {};
    const body: Record<string, unknown> = {
      model: this.model.replace(/^ollama\//, ''),
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
    };

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }, // no auth — local
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        yield {
          errorCode: 'OLLAMA_HTTP_ERROR',
          errorMessage: `Ollama returned ${res.status}: ${detail.slice(0, 400)}. Is the model pulled? Try: ollama pull ${body.model}`,
        };
        return;
      }

      const data: any = await res.json();
      const message = data.choices?.[0]?.message ?? {};

      const parts: any[] = [];
      const answer = stripThinkBlocks(message.content ?? '');
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
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield {
        errorCode: 'OLLAMA_UNREACHABLE',
        errorMessage:
          `Could not reach Ollama at ${this.baseUrl} (${msg}). ` +
          'Is it running? Start the Ollama app or run: ollama serve',
      };
    }
  }

  /**
   * Live/bidirectional streaming — not part of Ollama's OpenAI-compatible
   * surface. Throws to surface this clearly rather than silently failing.
   */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'OllamaLlm does not support live bidirectional connections. ' +
        'Use a Gemini model for live/streaming sessions.',
    );
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers OllamaLlm with the ADK LLMRegistry.
 *
 * Unlike registerClaudeLlm(), this needs no key gate — a local provider has
 * no credential to check. Registration is still explicit (not at import
 * time) so entrypoints stay in control of which providers are active.
 * If Ollama isn't running, agents fail at call time with a clear
 * OLLAMA_UNREACHABLE message that says how to start it.
 */
export function registerOllamaLlm(): void {
  LLMRegistry.register(OllamaLlm);
}
