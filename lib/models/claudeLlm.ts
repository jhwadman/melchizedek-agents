/**
 * lib/models/claudeLlm.ts — Anthropic Claude provider for the ADK LLMRegistry.
 *
 * WHY this file exists:
 *   The ADK JS package (@google/adk v1.x) is Gemini-native. It does not ship a
 *   Claude adapter the way the ADK Java SDK does. However, the ADK exposes a
 *   clean extension point: subclass BaseLlm, implement generateContentAsync(),
 *   and register the class via LLMRegistry.register(). The registry maps model
 *   name patterns to provider classes, so once registered, any LlmAgent with
 *   model: "claude-*" will automatically route through this class.
 *
 * HOW TO ENABLE:
 *   1. Install the Anthropic SDK:
 *        npm install @anthropic-ai/sdk
 *   2. Add your API key to .env:
 *        ANTHROPIC_API_KEY=sk-ant-...
 *   3. registerAvailableProviders() (lib/models/registry.ts) registers this
 *      adapter automatically when the key is set.
 *   4. Set model: "claude-sonnet-4-6" (or any claude-* id) in your YAML.
 *
 * CAPABILITIES:
 *   - Tools: FunctionTools AND MCP-discovered tools work. Tool schemas are
 *     normalized from the ADK/Gemini UPPERCASE dialect to the lowercase
 *     JSON-Schema types Anthropic requires (lib/models/schemaNormalize.ts).
 *   - web_search: declaring the `web_search` tool in YAML enables Anthropic's
 *     native web_search server tool — searches run on Anthropic's side.
 *   - Extended thinking: generateContentConfig.thinkingConfig.thinkingBudget
 *     maps to Anthropic's thinking parameter. Thinking blocks are surfaced
 *     as { text, thought: true } parts (display-only; kept out of session
 *     history). NOTE: thinking + tool use in the same agent is NOT supported
 *     this pass — Anthropic requires signed thinking blocks to be replayed
 *     on tool loops; the raw blocks are stashed in customMetadata
 *     ['anthropic.thinking'] for a future upgrade.
 *   - Token usage: response.usage is mapped to LlmResponse.usageMetadata, so
 *     traceAgentRun / llm.request spans count Claude tokens like Gemini's.
 *
 * LIMITATIONS vs Gemini:
 *   - generate_image tool uses the Gemini image model directly and is not
 *     affected by the inference model choice.
 *   - Live/bidirectional streaming (connect) is not supported.
 *
 * CONTENT FORMAT TRANSLATION:
 *   The ADK uses Google GenAI Content/Part objects internally. This adapter
 *   translates them to Anthropic MessageParam format and maps the response back
 *   to LlmResponse. Tool calls (function_call / function_response parts) are
 *   translated to Anthropic's tool_use / tool_result blocks.
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

// ── Type aliases to avoid @anthropic-ai/sdk import errors when not installed ─
// We use dynamic import inside the methods so the rest of the framework still
// boots correctly even when the Anthropic SDK is absent.

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
};

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

/** Anthropic's minimum extended-thinking budget. */
const MIN_THINKING_BUDGET = 1024;

// ── Request building (exported for offline tests) ────────────────────────────

/** ADK toolsDict → Anthropic tool definitions (lowercase schemas; the
 *  web_search sentinel becomes Anthropic's native server tool). */
export function buildAnthropicTools(llmRequest: LlmRequest): any[] {
  const anthropicTools: any[] = [];
  for (const [, tool] of Object.entries(llmRequest.toolsDict ?? {})) {
    if (isWebSearchSentinel(tool)) continue; // added as a server tool below
    const t = tool as any;
    if (t.name && t.description) {
      anthropicTools.push({
        name: t.name,
        description: t.description,
        input_schema: toLowercaseJsonSchema(
          t.parameters ?? { type: 'object', properties: {} },
        ),
      });
    }
  }
  if (wantsWebSearch(llmRequest)) {
    // Anthropic-native server tool: search runs on Anthropic's side, results
    // are grounded into the reply — no client-side execution.
    anthropicTools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 5,
    });
  }
  return anthropicTools;
}

// ── ClaudeLlm ─────────────────────────────────────────────────────────────────

export class ClaudeLlm extends BaseLlm {
  /**
   * Regex patterns that map model name strings to this provider.
   * Any model: "claude-*" in a YAML config will route here after registration.
   */
  static readonly supportedModels: Array<string | RegExp> = [/^claude-.+/];

  private apiKey?: string;

  constructor({ model, apiKey }: { model: string; apiKey?: string }) {
    super({ model });
    this.apiKey = apiKey;
  }

  /**
   * Main generation method called by the ADK Runner for every turn.
   *
   * We translate ADK's LlmRequest (Google Content format) → Anthropic
   * MessageParam format, call the Anthropic Messages API, then translate
   * the response back to LlmResponse. The whole call is wrapped in an
   * llm.request OpenTelemetry span (provider/model/tokens/latency).
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: 'anthropic', model: this.model },
      this.generateInner(llmRequest, stream),
    );
  }

  private async *generateInner(
    llmRequest: LlmRequest,
    stream: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const apiKey = this.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      yield {
        errorCode: 'MISSING_API_KEY',
        errorMessage: 'ANTHROPIC_API_KEY is not set in environment.',
      };
      return;
    }

    // Dynamic import — only loads @anthropic-ai/sdk when actually called,
    // so the framework boots without the SDK installed for Gemini-only users.
    let Anthropic: any;
    try {
      const mod = await import('@anthropic-ai/sdk');
      Anthropic = mod.default ?? mod.Anthropic;
    } catch {
      yield {
        errorCode: 'SDK_NOT_INSTALLED',
        errorMessage:
          'The @anthropic-ai/sdk package is not installed. Run: npm install @anthropic-ai/sdk',
      };
      return;
    }

    const client = new Anthropic({ apiKey });

    // ── Translate ADK Contents → Anthropic messages ──────────────────────────
    const systemParts: string[] = [];
    const messages: AnthropicMessage[] = [];

    for (const content of llmRequest.contents) {
      // System instruction lives in config.systemInstruction, not contents.
      // But ADK also injects it as a 'system' role content — extract it.
      if ((content as any).role === 'system') {
        const text = content.parts
          ?.filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('\n');
        if (text) systemParts.push(text);
        continue;
      }

      const role: 'user' | 'assistant' =
        content.role === 'model' ? 'assistant' : 'user';

      const blocks: AnthropicContentBlock[] = [];
      for (const part of content.parts ?? []) {
        const p = part as any;
        if (p.thought) {
          // Prior-turn scratchpad is display-only; never replay it as text.
          continue;
        }
        if (p.text) {
          blocks.push({ type: 'text', text: p.text });
        } else if (p.functionCall) {
          // ADK function_call → Anthropic tool_use
          blocks.push({
            type: 'tool_use',
            id: p.functionCall.id ?? `tool_${Date.now()}`,
            name: p.functionCall.name,
            input: p.functionCall.args ?? {},
          });
        } else if (p.functionResponse) {
          // ADK function_response → Anthropic tool_result
          blocks.push({
            type: 'tool_result',
            tool_use_id: p.functionResponse.id ?? '',
            content: JSON.stringify(p.functionResponse.response ?? {}),
          });
        }
      }

      if (blocks.length > 0) {
        messages.push({ role, content: blocks });
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

    // ── Build Anthropic tool definitions from ADK toolsDict ──────────────────
    const anthropicTools = buildAnthropicTools(llmRequest);
    if (wantsWebSearch(llmRequest)) {
      setLlmSpanAttribute('llm.web_search.native', true);
    }

    // ── Extended thinking (Gemini thinkingConfig → Anthropic thinking) ───────
    const cfg = (llmRequest.config as any) ?? {};
    let maxTokens: number = cfg.maxOutputTokens ?? 4096;
    let thinking: { type: 'enabled'; budget_tokens: number } | undefined;
    const requestedBudget = cfg.thinkingConfig?.thinkingBudget;
    if (typeof requestedBudget === 'number' && requestedBudget > 0) {
      const budget = Math.max(requestedBudget, MIN_THINKING_BUDGET);
      thinking = { type: 'enabled', budget_tokens: budget };
      // Anthropic requires max_tokens to exceed the thinking budget.
      maxTokens = Math.max(maxTokens, budget + 2048);
    }

    const requestBase = {
      model: this.model,
      max_tokens: maxTokens,
      system: systemParts.join('\n\n') || undefined,
      messages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      ...(thinking ? { thinking } : {}),
    };

    // ── Call Anthropic API ────────────────────────────────────────────────────
    try {
      if (stream) {
        // Streaming path
        const streamResponse = await client.messages.stream(requestBase);

        for await (const chunk of streamResponse) {
          if (chunk.type === 'content_block_delta') {
            if (chunk.delta.type === 'text_delta') {
              yield {
                content: {
                  role: 'model',
                  parts: [{ text: chunk.delta.text }],
                },
                partial: true,
              };
            } else if (chunk.delta.type === 'thinking_delta') {
              yield {
                content: {
                  role: 'model',
                  parts: [{ text: chunk.delta.thinking, thought: true } as any],
                },
                partial: true,
              };
            }
          }
        }

        // Final message: tool_use blocks, thinking stash, and token usage.
        const final = await streamResponse.finalMessage();
        yield this.finalResponse(final, /*includeText=*/ false);
      } else {
        // Non-streaming path
        const response = await client.messages.create(requestBase);

        // Thinking first, as a display-only partial.
        const thinkingText = (response.content ?? [])
          .filter((b: any) => b.type === 'thinking')
          .map((b: any) => b.thinking)
          .join('\n\n');
        if (thinkingText) {
          yield {
            content: {
              role: 'model',
              parts: [{ text: thinkingText, thought: true } as any],
            },
            partial: true,
          };
        }

        yield this.finalResponse(response, /*includeText=*/ true);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { errorCode: 'ANTHROPIC_ERROR', errorMessage: msg };
    }
  }

  /** Maps a complete Anthropic message → the final LlmResponse. */
  private finalResponse(response: any, includeText: boolean): LlmResponse {
    const parts: any[] = [];
    const thinkingBlocks: any[] = [];
    for (const block of response.content ?? []) {
      if (block.type === 'text' && includeText) {
        parts.push({ text: block.text });
      } else if (block.type === 'tool_use') {
        parts.push({
          functionCall: { name: block.name, args: block.input, id: block.id },
        });
      } else if (block.type === 'thinking') {
        // Raw signed blocks, preserved for a future thinking+tools upgrade
        // (Anthropic requires them replayed verbatim on tool loops).
        thinkingBlocks.push(block);
      }
    }

    const usage = response.usage;
    return {
      ...(parts.length > 0 ? { content: { role: 'model', parts } } : {}),
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
              ...(usage.input_tokens !== undefined &&
              usage.output_tokens !== undefined
                ? { totalTokenCount: usage.input_tokens + usage.output_tokens }
                : {}),
            },
          }
        : {}),
      ...(thinkingBlocks.length > 0
        ? { customMetadata: { 'anthropic.thinking': thinkingBlocks } }
        : {}),
    };
  }

  /**
   * Live/bidirectional streaming connection — not supported by the Anthropic
   * Messages API. Throws to surface this clearly rather than silently failing.
   */
  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error(
      'ClaudeLlm does not support live bidirectional connections. ' +
        'Use a Gemini model for live/streaming sessions.',
    );
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers ClaudeLlm with the ADK LLMRegistry.
 *
 * WHY a separate function instead of auto-registering at import time:
 *   Auto-registration at module load would cause every consumer of this file
 *   to unconditionally register Claude, even if ANTHROPIC_API_KEY is absent.
 *   By making registration explicit, registerAvailableProviders() can
 *   conditionally call this only when the key is present, and log a clear
 *   message about which provider is active.
 */
export function registerClaudeLlm(): void {
  LLMRegistry.register(ClaudeLlm);
}
