/**
 * lib/models/grokLlm.ts — xAI Grok provider for the ADK LLMRegistry.
 *
 * WHY this file exists:
 *   Model optionality is a primary driver of this framework: the agent YAML
 *   declares `model`, and the registry routes it to the right provider.
 *   xAI's API is OpenAI-compatible, so this adapter is a thin subclass of
 *   lib/models/openAiCompatibleLlm.ts (shared with Ollama) — endpoint, auth
 *   header, and two xAI-specific surfaces:
 *     - reasoning: grok reasoning models return reasoning_content on the
 *       message (handled by the base's default extractReasoning).
 *     - web search: xAI Live Search via the search_parameters body field —
 *       enabled when the agent declares the `web_search` tool.
 *
 * HOW TO ENABLE:
 *   1. Add your API key to .env:  XAI_API_KEY=xai-...
 *      (console.x.ai — paid)
 *   2. Set model: "grok-4-1-fast" (or any grok-* id) in your YAML.
 *   registerAvailableProviders() registers this adapter when the key is set.
 *
 * API-DRIFT NOTE: search_parameters and reasoning_content are the current
 * xAI chat-completions surface. If xAI moves them, this file is the only
 * place to update (webSearchBodyFields / extractReasoning).
 */

import { LLMRegistry } from '@google/adk';
import type { LlmResponse } from '@google/adk';

import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';

const XAI_ENDPOINT = 'https://api.x.ai/v1/chat/completions';

// ── GrokLlm ───────────────────────────────────────────────────────────────────

export class GrokLlm extends OpenAiCompatibleLlm {
  /** Any model: "grok-*" in a YAML config routes here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [/^grok-.+/];

  private apiKey?: string;

  constructor({ model, apiKey }: { model: string; apiKey?: string }) {
    super({ model });
    this.apiKey = apiKey;
  }

  protected providerId(): string {
    return 'xai';
  }

  protected endpointUrl(): string {
    return XAI_ENDPOINT;
  }

  protected headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey ?? process.env.XAI_API_KEY ?? ''}`,
    };
  }

  protected missingRequirement(): LlmResponse | undefined {
    if (this.apiKey || process.env.XAI_API_KEY) return undefined;
    return {
      errorCode: 'MISSING_API_KEY',
      errorMessage: 'XAI_API_KEY is not set in environment.',
    };
  }

  /** xAI Live Search — the model searches the web server-side. */
  protected webSearchBodyFields(): Record<string, unknown> | null {
    return { search_parameters: { mode: 'auto' } };
  }
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers GrokLlm with the ADK LLMRegistry. Called by
 * registerAvailableProviders() when XAI_API_KEY is present.
 */
export function registerGrokLlm(): void {
  LLMRegistry.register(GrokLlm);
}
