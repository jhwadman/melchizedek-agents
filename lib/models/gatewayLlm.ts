/**
 * lib/models/gatewayLlm.ts — the one-key fallback adapter.
 *
 * WHY this file exists:
 *   Serves any cloud model id through a hosted gateway's OpenAI-compatible
 *   chat-completions endpoint when the provider's direct key is absent
 *   (lib/models/gateway.ts owns that decision). It subclasses the
 *   chat-completions base the way Ollama does — not GptLlm, which speaks
 *   OpenAI's Responses API — because chat completions is the one dialect
 *   every gateway serves.
 *
 * WHAT STAYS TRUE THROUGH THE GATEWAY:
 *   - Attribution. providerId() is the YAML id's provider (anthropic,
 *     openai, gemini, xai), never "gateway", so the ledger and ymir's
 *     per-agent cost trends keep the same provider column (ADR 0009). The
 *     transport is a separate span attribute: llm.transport = gateway:<id>.
 *   - Tool calling, structured output, reasoning_effort, streaming and
 *     token accounting — all provided by the base class.
 *
 * WHAT IS LOST — and reported:
 *   Every server-side tool sentinel (web_search, google_search, x_search,
 *   collections_search). The base omits web_search with a warning and marks
 *   the span; lib/models/capabilities.ts names the loss per agent for the
 *   doctor and the A2A startup log.
 *
 * Registration: LLMRegistry keys on regex OBJECTS, so a gateway class must
 * carry the SAME supportedModels instances as the direct adapter it stands
 * in for (see gatewayClassFor in registry.ts).
 */

import { LLMRegistry } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { OpenAiCompatibleLlm } from './openAiCompatibleLlm.ts';
import {
  GATEWAY_ENV,
  GATEWAY_KEY_ENV,
  GATEWAY_MODEL_MAP_ENV,
  gatewayConfig,
  gatewayWireModel,
} from './gateway.ts';
import type { GatewayConfig } from './gateway.ts';
import { providerForModel } from './providerMap.ts';

export class GatewayLlm extends OpenAiCompatibleLlm {
  /** Never registered directly — see gatewayClassFor(). */
  static readonly supportedModels: Array<string | RegExp> = [];

  private readonly cfg: GatewayConfig | null;

  constructor({ model }: { model: string }) {
    super({ model });
    this.cfg = gatewayConfig();
  }

  /** Attribution stays with the upstream provider named by the YAML id. */
  protected providerId(): string {
    return providerForModel(this.model);
  }

  protected override transport(): string {
    return this.cfg ? `gateway:${this.cfg.gateway.id}` : 'gateway';
  }

  protected endpointUrl(): string {
    const base = this.cfg?.baseUrl ?? '';
    return `${base}/chat/completions`;
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${process.env[GATEWAY_KEY_ENV] ?? ''}` };
  }

  protected override wireModelName(): string {
    return this.cfg ? gatewayWireModel(this.model, this.cfg.gateway) : this.model;
  }

  protected override missingRequirement(): LlmResponse | undefined {
    if (!this.cfg) {
      return {
        errorCode: 'GATEWAY_NOT_CONFIGURED',
        errorMessage: `${GATEWAY_ENV} is not set to a known gateway, so ${this.model} has no route.`,
      };
    }
    if (!this.cfg.keyPresent) {
      return {
        errorCode: 'GATEWAY_KEY_MISSING',
        errorMessage: `${GATEWAY_ENV}=${this.cfg.gateway.id} but ${GATEWAY_KEY_ENV} is not set.`,
      };
    }
    return undefined;
  }

  // webSearchBodyFields() stays at the base default (null): a gateway has no
  // uniform switch for upstream native search, so the tool is dropped and
  // the loss is reported (llm.capability.dropped, the doctor, the startup log).

  protected override httpError(status: number, detail: string): LlmResponse {
    const label = this.cfg?.gateway.label ?? 'gateway';
    const hint =
      status === 404 || status === 400
        ? ` If the model id is the problem, map it with ${GATEWAY_MODEL_MAP_ENV}=${this.model}=<gateway id>.`
        : '';
    return {
      errorCode: 'GATEWAY_HTTP_ERROR',
      errorMessage: `${label} returned ${status} for ${this.wireModelName()}: ${detail.slice(0, 4000)}.${hint}`,
    };
  }

  protected override extraBodyFields(_llmRequest: LlmRequest): Record<string, unknown> {
    return {};
  }
}

/**
 * A GatewayLlm subclass that answers for the given model patterns. Pass the
 * direct adapter's OWN `supportedModels` array so the registry entry
 * REPLACES that adapter's (the dict is keyed by regex object) rather than
 * adding a second, shadowed match.
 */
export function gatewayClassFor(patterns: Array<string | RegExp>): typeof GatewayLlm {
  return class GatewayLlmFor extends GatewayLlm {
    static override readonly supportedModels: Array<string | RegExp> = patterns;
  };
}

/** Registers a gateway stand-in for the given patterns. */
export function registerGatewayLlm(patterns: Array<string | RegExp>): void {
  LLMRegistry.register(gatewayClassFor(patterns));
}
