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
 *   3. Import and call registerClaudeLlm() once at the start of your script
 *      (syndicate_chat.ts already does this automatically when the key is set).
 *   4. Set model: "claude-sonnet-4-6" (or any claude-* id) in your YAML.
 *
 * LIMITATIONS vs Gemini:
 *   - GOOGLE_SEARCH grounding is not available for Claude agents. Remove the
 *     google_search tool from any subagent that switches to Claude.
 *   - thinkingConfig in generateContentConfig is Gemini-only. Use Claude's
 *     native extended thinking via the Anthropic SDK config instead (see below).
 *   - generate_image tool uses the Gemini image model directly and is not
 *     affected by the inference model choice.
 *   - KNOWN BUG — MCP-discovered tools (mcp_server_url) do not work on
 *     claude-* agents yet. lib/tools/mcpToolFactory.ts emits Gemini-style
 *     UPPERCASE schema types ('OBJECT', 'STRING', …), and this adapter
 *     forwards tool.parameters verbatim as Anthropic's input_schema, which
 *     requires lowercase JSON-Schema types. Anthropic rejects the request:
 *       400 invalid_request_error: tools.N.custom.input_schema.type:
 *       Input should be 'object'
 *     This is a translation gap, not a protocol incompatibility — the fix is
 *     to deep-lowercase `type` values when building anthropicTools below
 *     (without mutating the shared tool object, which a Gemini agent may
 *     also hold). Until then this adapter emits a loud warning (see
 *     warnOnGeminiStyleSchemas) and the workaround is: run MCP-tool agents
 *     on a Gemini model, or lowercase the schema types on the FunctionTool
 *     before building the agent. See DOCUMENTATION.md §7.1.
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

// ── Gemini-style schema detection ────────────────────────────────────────────
// KNOWN BUG (see LIMITATIONS in the header): tools built for Gemini — every
// MCP-discovered tool from lib/tools/mcpToolFactory.ts, and any FunctionTool
// declared with UPPERCASE schema types — will be rejected by the Anthropic
// API. Until the adapter normalizes them, fail LOUDLY and actionably instead
// of letting the user hit a cryptic 400.

/** Recursively find one UPPERCASE `type` value in a JSON schema, or null. */
function findUppercaseSchemaType(node: unknown): string | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findUppercaseSchemaType(item);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === 'string' && /^[A-Z]+$/.test(obj.type)) return obj.type;
  for (const value of Object.values(obj)) {
    const hit = findUppercaseSchemaType(value);
    if (hit) return hit;
  }
  return null;
}

let schemaWarningPrinted = false;

function warnOnGeminiStyleSchemas(model: string, anthropicTools: Array<{ name: string; input_schema: unknown }>): void {
  const offending = anthropicTools
    .map((t) => ({ name: t.name, badType: findUppercaseSchemaType(t.input_schema) }))
    .filter((t): t is { name: string; badType: string } => t.badType !== null);
  if (offending.length === 0 || schemaWarningPrinted) return;
  schemaWarningPrinted = true;
  const names = offending.map((t) => `"${t.name}" (type: '${t.badType}')`).join(', ');
  console.warn(
    [
      '',
      '╔════════════════════════════════════════════════════════════════════╗',
      '║  ⚠  CLAUDE + MCP TOOLS: THIS REQUEST WILL BE REJECTED              ║',
      '╚════════════════════════════════════════════════════════════════════╝',
      `  Agent model "${model}" declares tools with Gemini-style UPPERCASE`,
      `  schema types: ${names}.`,
      "  The Anthropic API requires lowercase JSON-Schema types ('object',",
      "  'string', …) and will refuse the call with:",
      "    400 invalid_request_error: tools.N.custom.input_schema.type:",
      "        Input should be 'object'",
      '',
      '  This affects EVERY claude-* agent whose tools were discovered from an',
      '  MCP server (lib/tools/mcpToolFactory.ts emits uppercase types for',
      '  Gemini compatibility). It is a known melchizedek bug, not an Anthropic',
      '  outage. Workarounds until the adapter normalizes schema types:',
      '    • run MCP-tool agents on a gemini-* model, or',
      '    • deep-lowercase the schema `type` values on each FunctionTool',
      '      before building the LlmAgent.',
      '  Details: DOCUMENTATION.md §7.1 "Using Claude Models" and the',
      '  LIMITATIONS header of lib/models/claudeLlm.ts.',
      '',
    ].join('\n'),
  );
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
   * the response back to LlmResponse.
   */
  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
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
    const anthropicTools: any[] = [];
    for (const [, tool] of Object.entries(llmRequest.toolsDict ?? {})) {
      const t = tool as any;
      if (t.name && t.description) {
        anthropicTools.push({
          name: t.name,
          description: t.description,
          input_schema: t.parameters ?? { type: 'object', properties: {} },
        });
      }
    }
    warnOnGeminiStyleSchemas(this.model, anthropicTools);

    // ── Call Anthropic API ────────────────────────────────────────────────────
    const maxTokens =
      (llmRequest.config as any)?.maxOutputTokens ?? 4096;

    try {
      if (stream) {
        // Streaming path
        const streamResponse = await client.messages.stream({
          model: this.model,
          max_tokens: maxTokens,
          system: systemParts.join('\n\n') || undefined,
          messages,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        });

        let buffer = '';
        for await (const chunk of streamResponse) {
          if (
            chunk.type === 'content_block_delta' &&
            chunk.delta.type === 'text_delta'
          ) {
            buffer += chunk.delta.text;
            yield {
              content: {
                role: 'model',
                parts: [{ text: chunk.delta.text }],
              },
              partial: true,
            };
          }
        }

        // Final message for tool_use blocks
        const final = await streamResponse.finalMessage();
        const toolUseBlocks = final.content.filter(
          (b: any) => b.type === 'tool_use',
        );
        if (toolUseBlocks.length > 0) {
          yield {
            content: {
              role: 'model',
              parts: toolUseBlocks.map((b: any) => ({
                functionCall: { name: b.name, args: b.input, id: b.id },
              })),
            },
            turnComplete: true,
          };
        } else {
          yield { turnComplete: true };
        }
      } else {
        // Non-streaming path
        const response = await client.messages.create({
          model: this.model,
          max_tokens: maxTokens,
          system: systemParts.join('\n\n') || undefined,
          messages,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        });

        const parts: any[] = [];
        for (const block of response.content) {
          if (block.type === 'text') {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: { name: block.name, args: block.input, id: block.id },
            });
          }
        }

        yield {
          content: { role: 'model', parts },
          turnComplete: true,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { errorCode: 'ANTHROPIC_ERROR', errorMessage: msg };
    }
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
 *   By making registration explicit, syndicate_chat.ts can conditionally call
 *   this only when the key is present, and log a clear message about which
 *   provider is active.
 *
 * Call this once, before constructing any Runner, in any script that wants
 * Claude support:
 *   import { registerClaudeLlm } from '../lib/models/claudeLlm.ts';
 *   registerClaudeLlm();
 */
export function registerClaudeLlm(): void {
  LLMRegistry.register(ClaudeLlm);
}
