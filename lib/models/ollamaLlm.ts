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
 *   2. Pull a model that supports tool calling (see the table below):
 *        ollama pull qwen3.5:9b      # the default recommendation
 *        ollama pull qwen3.5:4b      # lighter; teaching and small machines
 *   3. Set model: "ollama/qwen3.5:9b" in your YAML. No API key needed —
 *      registerAvailableProviders() registers this provider unconditionally.
 *   Optional: OLLAMA_BASE_URL in .env overrides the default endpoint
 *   (http://localhost:11434/v1 — Ollama's OpenAI-compatible API).
 *
 * CHOOSING A MODEL (current as of August 2026):
 *   The binding constraint is memory, not taste. A model must fit in RAM
 *   (unified memory on Apple Silicon) with room left for the KV cache and
 *   the OS — as a rule of thumb, the weights should occupy no more than
 *   ~70% of total memory. Every model below is Apache-2.0 and does native
 *   tool calling, which is the capability floor for agent work.
 *
 *     model                Q4 size   fits comfortably in   use it for
 *     ───────────────────────────────────────────────────────────────────
 *     qwen3.5:2b            2.7 GB   8 GB                  toy / CI runs
 *     qwen3.5:4b            3.4 GB   8–16 GB               teaching, demos
 *     qwen3.5:9b            6.6 GB   16 GB+                DEFAULT — real work
 *     qwen3.5:27b            17 GB   32 GB+                heavier local work
 *     qwen3.8:27b            18 GB   32 GB+                strongest local
 *
 *   Qwen3.8 (August 2026) is the strongest open-weight Qwen and the one to
 *   reach for on a 32 GB+ machine, but it ships in 27B ONLY — 18 GB of
 *   weights before any context — so it does not fit the 16/18 GB laptops
 *   this framework is usually developed on. Qwen3.5 (February 2026) is the
 *   newest generation that offers small dense sizes, which is why the
 *   default here is qwen3.5:9b rather than the bigger number. Qwen3.7 is
 *   API-only and has no weights to pull.
 *
 *   Vision: qwen3-vl:8b remains the pinned choice for image work; the
 *   qwen3.5 family is multimodal, so ollama/qwen3.5:9b also accepts images.
 *
 * DESIGN NOTES:
 *   - Zero dependencies: talks to Ollama's OpenAI-compatible endpoint with
 *     the built-in fetch — the shared translation core lives in
 *     lib/models/openAiCompatibleLlm.ts.
 *   - The "ollama/" prefix is a routing namespace for the LLMRegistry and is
 *     stripped before the HTTP call (Ollama knows the model as "qwen3:8b").
 *   - Reasoning models (qwen3 family) emit <think>…</think> blocks before
 *     their answer. The base class surfaces them as a { thought: true }
 *     part — printers show the scratchpad dimmed; it stays out of history.
 *   - Vision: ADK inlineData parts (images) are translated to OpenAI
 *     image_url data URIs, so ollama/qwen3-vl:8b can see attached images.
 *
 * LIMITATIONS vs Gemini:
 *   - web_search: a local model has no native search, so the tool is
 *     omitted with a warning. A local agent's grounding is what you supply:
 *     pasted material, subagents, or MCP tools.
 *   - generate_image / inspect_image call Gemini image models directly and
 *     still require a Gemini key regardless of the inference model.
 *   - thinkingConfig is Gemini-only; qwen3 thinks on its own schedule.
 */

import { LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';

const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

// ── OllamaLlm ─────────────────────────────────────────────────────────────────

export class OllamaLlm extends OpenAiCompatibleLlm {
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

  protected providerId(): string {
    return 'ollama';
  }

  protected endpointUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    return {}; // no auth — local
  }

  protected wireModelName(): string {
    return this.model.replace(/^ollama\//, '');
  }

  // webSearchBodyFields() stays at the base default (null): no native
  // search locally — the tool is omitted with a warning, keys stay optional.

  protected httpError(status: number, detail: string): LlmResponse {
    return {
      errorCode: 'OLLAMA_HTTP_ERROR',
      errorMessage: `Ollama returned ${status}: ${detail.slice(0, 400)}. Is the model pulled? Try: ollama pull ${this.wireModelName()}`,
    };
  }

  protected unreachable(message: string): LlmResponse {
    return {
      errorCode: 'OLLAMA_UNREACHABLE',
      errorMessage:
        `Could not reach Ollama at ${this.baseUrl} (${message}). ` +
        'Is it running? Start the Ollama app or run: ollama serve',
    };
  }

  protected extraBodyFields(_llmRequest: LlmRequest): Record<string, unknown> {
    return {};
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
