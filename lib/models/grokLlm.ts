/**
 * lib/models/grokLlm.ts — xAI Grok provider for the ADK LLMRegistry.
 *
 * WHY this file exists:
 *   Model optionality is a primary driver of this framework: the agent YAML
 *   declares `model`, and the registry routes it to the right provider.
 *
 * WHY it subclasses GptLlm (Responses API) and not the chat-completions base:
 *   xAI retired Live Search on chat completions (the API now returns
 *   410 "Live search is deprecated. Please switch to the Agent Tools API").
 *   The Agent Tools API lives at `https://api.x.ai/v1/responses` and is
 *   wire-compatible with OpenAI's Responses API — same `input` items, same
 *   `{ type: 'function' }` / `{ type: 'web_search' }` tools, same
 *   `reasoning` summary / `message` / `function_call` output items (verified
 *   live 2026-07-19). So Grok reuses the GptLlm translator via the openai
 *   SDK's baseURL override, and gets for free:
 *     - native web_search (server-side, with source citations)
 *     - reasoning summaries surfaced as { thought: true } THINKING output
 *     - function tools with call_id round-tripping, lowercased schemas
 *     - usage → usageMetadata mapping for llm.request token spans
 *
 * HOW TO ENABLE:
 *   1. Add your API key to .env:  XAI_API_KEY=xai-...   (console.x.ai — paid)
 *   2. Set model: "grok-4.5" (or any grok-* id) in your YAML.
 *   registerAvailableProviders() registers this adapter when the key is set.
 *   grok-4.5 requests carry reasoning effort 'medium' by default — see
 *   reasoningParam() below and DEFAULT_GROK_REASONING_EFFORT (lib/config.ts).
 *
 * API-DRIFT NOTE: every xAI-specific choice (endpoint, key env) is confined
 * to the overrides below — upstream drift stays a one-file fix. Note xAI's
 * Responses endpoint reports the serving backend in the response `model`
 * field (e.g. "grok-4.3"), which may differ from the requested id; invalid
 * ids are properly rejected with "Model not found".
 */

import { LLMRegistry } from '@google/adk';

import { DEFAULT_GROK_REASONING_EFFORT } from '../config.ts';
import { GptLlm } from './gptLlm.ts';

const XAI_BASE_URL = 'https://api.x.ai/v1';

// ── GrokLlm ───────────────────────────────────────────────────────────────────

export class GrokLlm extends GptLlm {
  /** Any model: "grok-*" in a YAML config routes here after registration. */
  static readonly supportedModels: Array<string | RegExp> = [/^grok-.+/];

  protected providerId(): string {
    return 'xai';
  }

  protected baseURL(): string {
    return XAI_BASE_URL;
  }

  protected apiKeyFromEnv(): string | undefined {
    return process.env.XAI_API_KEY;
  }

  protected missingKeyMessage(): string {
    return 'XAI_API_KEY is not set in environment.';
  }

  /** grok-4.5 exposes reasoning-effort control ('low' | 'medium' | 'high';
   *  xAI defaults to 'high', and reasoning cannot be disabled) via the
   *  Responses API `reasoning.effort` field — docs.x.ai › Model
   *  capabilities › Text › Reasoning › Effort levels. We pin
   *  DEFAULT_GROK_REASONING_EFFORT (medium). Other grok ids don't accept
   *  the param and get none (their reasoning summaries arrive unrequested);
   *  if xAI ever rejects it, GptLlm's guarded 400 retry drops it. */
  protected reasoningParam(): Record<string, unknown> | undefined {
    if (/^grok-4\.5/.test(this.model)) {
      return { effort: DEFAULT_GROK_REASONING_EFFORT };
    }
    return undefined;
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
