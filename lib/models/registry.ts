/**
 * lib/models/registry.ts — unified model routing. THE seam for model
 * optionality: an agent's YAML declares `model`, and this module makes sure
 * that string reaches the right provider adapter.
 *
 * TWO RESOLUTION PATHS, ONE PREFIX TABLE (lib/models/providerMap.ts):
 *
 *   1. registerAvailableProviders() — for entrypoints that pass `model` as a
 *      STRING to LlmAgent (scripts/syndicate_chat.ts). Registers every
 *      adapter whose credentials exist into the ADK LLMRegistry; the
 *      registry then string-matches supportedModels patterns:
 *        claude-*  → ClaudeLlm      gpt-* / o<digit>* → GptLlm
 *        grok-*    → GrokLlm        ollama/<model>    → OllamaLlm
 *        gemini-*  → TracedGemini (ADK's Gemini + llm.request spans)
 *
 *   2. resolveModel() — instance factory for BYOK paths (scripts/
 *      a2a_server.ts), where a per-request API key from an HTTP header must
 *      be injected into the adapter. Same prefix table; the YAML model
 *      string always wins over the X-Provider header (which only selects a
 *      DEFAULT model when the YAML omits `model` — a deprecated affordance).
 *
 * Register BEFORE constructing any agent: the LLMRegistry caches model→class
 * resolution (LRU), so late registration can be masked by stale cache hits.
 */

import { Gemini, LLMRegistry } from '@google/adk';
import type { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GPT_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_OLLAMA_MODEL,
} from '../config.ts';
import {
  traceLlmGeneration,
  setLlmSpanAttribute,
} from '../observability/tracer.ts';
import { ClaudeLlm, registerClaudeLlm } from './claudeLlm.ts';
import { GptLlm, registerGptLlm } from './gptLlm.ts';
import { GrokLlm, registerGrokLlm } from './grokLlm.ts';
import { OllamaLlm, registerOllamaLlm } from './ollamaLlm.ts';
import { GatewayLlm, registerGatewayLlm } from './gatewayLlm.ts';
import {
  gatewayConfig,
  gatewayProblem,
  gatewayUsable,
  planTransport,
} from './gateway.ts';
import {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
} from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';

export { providerForModel, providerKeyPresent, PROVIDERS };
export type { ProviderId };
export { gatewayConfig, gatewayProblem, gatewayUsable, planTransport, GATEWAYS } from './gateway.ts';
export type { GatewayId, GatewayInfo, TransportPlan } from './gateway.ts';
export { describeCapabilities, capabilitySummary } from './capabilities.ts';
export type { CapabilityReport } from './capabilities.ts';
export { GatewayLlm };

// ── TracedGemini ─────────────────────────────────────────────────────────────
// ADK's built-in Gemini adapter, wrapped so Gemini calls emit the same
// per-request llm.request spans (tokens, latency) as every other provider.

export class TracedGemini extends Gemini {
  // CRITICAL: reuse Gemini's exact regex instances. The LLMRegistry dict is
  // keyed by the regex OBJECT — registering the same instances REPLACES the
  // built-in Gemini entries instead of adding shadowed duplicates.
  static readonly supportedModels: Array<string | RegExp> =
    Gemini.supportedModels;

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    yield* traceLlmGeneration(
      { provider: 'gemini', model: this.model, llmRequest },
      this.tagAndGenerate(llmRequest, stream),
    );
  }

  /** Tags the llm.request span (web_search = Gemini grounding), then
   *  delegates to ADK's Gemini. Runs inside the span context. */
  private async *tagAndGenerate(
    llmRequest: LlmRequest,
    stream?: boolean,
  ): AsyncGenerator<LlmResponse, void> {
    const hasGrounding = (llmRequest.config?.tools ?? []).some(
      (t: any) => t && (t.googleSearch || t.googleSearchRetrieval),
    );
    if (hasGrounding) setLlmSpanAttribute('llm.web_search.native', true);
    yield* super.generateContentAsync(llmRequest, stream);
  }
}

// ── Availability + registration ──────────────────────────────────────────────

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  available: boolean;
  /**
   * How this provider's ids will be served: its own endpoint, or the
   * configured gateway standing in because the direct key is absent
   * (lib/models/gateway.ts). Absent when unavailable.
   */
  transport?: 'direct' | 'gateway';
  /** Gateway id when transport is 'gateway'. */
  gateway?: string;
  /** Why the provider is unavailable (e.g. which env var is missing). */
  reason?: string;
}

/** Availability report without side effects (used by demos and key gates). */
export function providerStatuses(): ProviderStatus[] {
  const gw = gatewayUsable() ? gatewayConfig() : null;
  return (Object.keys(PROVIDERS) as ProviderId[]).map((provider) => {
    const label = PROVIDERS[provider].label;
    if (providerKeyPresent(provider)) {
      return { provider, label, available: true, transport: 'direct' as const };
    }
    if (gw && provider !== 'ollama') {
      return {
        provider,
        label,
        available: true,
        transport: 'gateway' as const,
        gateway: gw.gateway.id,
      };
    }
    return {
      provider,
      label,
      available: false,
      reason: `${PROVIDERS[provider].keyEnv} not set`,
    };
  });
}

const REGISTRARS: Record<ProviderId, () => void> = {
  gemini: () => LLMRegistry.register(TracedGemini),
  anthropic: registerClaudeLlm,
  openai: registerGptLlm,
  xai: registerGrokLlm,
  ollama: registerOllamaLlm,
};

/**
 * The direct adapter's OWN supportedModels per provider. A gateway stand-in
 * must register under these exact regex instances so it REPLACES the
 * direct entry (the LLMRegistry dict is keyed by regex object) instead of
 * sitting behind it unmatched. Gemini's are ADK's built-in patterns, which
 * are registered at import time — replacing them is how TracedGemini works
 * too.
 */
const PATTERNS: Record<Exclude<ProviderId, 'ollama'>, Array<string | RegExp>> = {
  gemini: Gemini.supportedModels,
  anthropic: ClaudeLlm.supportedModels,
  openai: GptLlm.supportedModels,
  xai: GrokLlm.supportedModels,
};

let providersRegistered = false;

/**
 * Registers every adapter whose credentials exist into the ADK LLMRegistry
 * (Ollama unconditionally — local needs no key; Gemini always, since the
 * registry needs a fallback class, and a missing Gemini key surfaces as a
 * clear API error at call time). When MODEL_GATEWAY is configured, a
 * provider whose direct key is ABSENT is served by the gateway stand-in
 * instead (lib/models/gateway.ts — the fallback rule). Returns the
 * per-provider statuses so entrypoints can log which models are routable.
 */
export function registerAvailableProviders(
  log?: (msg: string) => void,
): ProviderStatus[] {
  const statuses = providerStatuses();
  if (!providersRegistered) {
    providersRegistered = true;
    for (const status of statuses) {
      if (status.transport === 'gateway' && status.provider !== 'ollama') {
        registerGatewayLlm(PATTERNS[status.provider]);
      } else if (status.available || status.provider === 'gemini') {
        REGISTRARS[status.provider]();
      }
    }
  }
  if (log) {
    const problem = gatewayProblem();
    if (problem) log(`⚠ ${problem} — gateway ignored`);
    for (const s of statuses) {
      if (!s.available) {
        log(`⚠ ${s.label} disabled (${s.reason}) — ${modelHint(s.provider)} models unavailable`);
      } else if (s.transport === 'gateway') {
        log(`◇ ${s.label} — via gateway:${s.gateway} (${modelHint(s.provider)} served without native search)`);
      } else {
        log(`✓ ${s.label} — active`);
      }
    }
  }
  return statuses;
}

function modelHint(provider: ProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-*';
    case 'openai':
      return 'gpt-*/o*';
    case 'xai':
      return 'grok-*';
    case 'ollama':
      return 'ollama/*';
    case 'gemini':
      return 'gemini-*';
  }
}

// ── Instance factory (BYOK paths) ────────────────────────────────────────────

export interface ResolveModelOptions {
  /** Per-request API key (e.g. the A2A X-Api-Key header). */
  apiKey?: string;
  /**
   * DEPRECATED — the A2A X-Provider header. Only consulted when `model` is
   * undefined, to pick that provider's default model. A model id in the
   * YAML always wins.
   */
  defaultProvider?: string;
}

const DEFAULT_MODEL_FOR: Record<ProviderId, string> = {
  gemini: DEFAULT_GEMINI_MODEL,
  anthropic: DEFAULT_CLAUDE_MODEL,
  openai: DEFAULT_GPT_MODEL,
  xai: DEFAULT_GROK_MODEL,
  ollama: DEFAULT_OLLAMA_MODEL,
};

/**
 * Resolves a model id (from YAML) to a provider adapter INSTANCE, injecting
 * a per-request apiKey where the provider accepts one. When `model` is
 * undefined, falls back to the default model of `defaultProvider` (or
 * Gemini).
 */
export function resolveModel(
  model: string | undefined,
  options: ResolveModelOptions = {},
): BaseLlm {
  const resolved =
    model ??
    DEFAULT_MODEL_FOR[normalizeProvider(options.defaultProvider)];
  // BYOK is scoped to the CALLER'S provider: the X-API-Key a client sends
  // authenticates that client's own provider (typically Gemini). Passing it
  // to a different provider's adapter would override the server's env key
  // (adapters prefer a passed key) and fail auth — e.g. a Gemini key sent to
  // xAI. Cross-provider agents therefore resolve keys from server env.
  const apiKey =
    providerForModel(
      model ?? DEFAULT_MODEL_FOR[normalizeProvider(options.defaultProvider)],
    ) === normalizeProvider(options.defaultProvider)
      ? options.apiKey
      : undefined;

  // The fallback rule (lib/models/gateway.ts): the direct adapter whenever
  // the provider's key — from env, or the caller's own BYOK key — is
  // present; the gateway stand-in only when it is absent and a gateway is
  // configured. The gateway key is server env only, never a request header.
  if (planTransport(resolved, { callerKey: !!apiKey }).transport === 'gateway') {
    return new GatewayLlm({ model: resolved });
  }

  switch (providerForModel(resolved)) {
    case 'ollama':
      return new OllamaLlm({ model: resolved });
    case 'anthropic':
      return new ClaudeLlm({ model: resolved, apiKey });
    case 'openai':
      return new GptLlm({ model: resolved, apiKey });
    case 'xai':
      return new GrokLlm({ model: resolved, apiKey });
    case 'gemini':
      return new TracedGemini({ model: resolved, apiKey });
  }
}

function normalizeProvider(provider?: string): ProviderId {
  const p = provider?.toLowerCase();
  if (p === 'ollama' || p === 'anthropic' || p === 'openai' || p === 'xai') {
    return p;
  }
  return 'gemini';
}
