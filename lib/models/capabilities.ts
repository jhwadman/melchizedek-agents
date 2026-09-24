/**
 * lib/models/capabilities.ts — what an agent keeps and loses on the path
 * its model will actually take.
 *
 * WHY this file exists:
 *   A model id is the whole routing decision, and some of what an agent
 *   declares only exists on one provider: Gemini grounding, xAI's x_search
 *   and Collections, the server-side web_search sentinel that every cloud
 *   adapter turns into its provider's native search. Until now the only
 *   defence against losing one was a one-time console.warn inside an
 *   adapter. This module states the loss BEFORE a request is made, per
 *   agent, on the RESOLVED transport (direct or gateway), so the doctor
 *   (lib/doctor.ts), the A2A startup log (lib/compile.ts) and the ledger
 *   (llm.capability.dropped) all say the same thing.
 *
 * It knows nothing about gateways beyond planTransport(); a future
 * transport that restores a native feature changes the table here, not
 * the callers.
 */

import { PROVIDERS } from './providerMap.ts';
import type { ProviderId } from './providerMap.ts';
import { planTransport } from './gateway.ts';
import type { TransportPlan } from './gateway.ts';

/**
 * Server-side tool sentinels and the providers whose DIRECT adapter
 * honours them natively. Anything not listed is a client-side function
 * tool and travels on every path.
 */
export const SERVER_SIDE_TOOLS: Record<string, ProviderId[]> = {
  web_search: ['gemini', 'anthropic', 'openai', 'xai'],
  google_search: ['gemini'],
  x_search: ['xai'],
  collections_search: ['xai'],
};

export interface CapabilityReport {
  model: string;
  provider: ProviderId;
  providerLabel: string;
  transport: TransportPlan['transport'];
  /** Gateway id when transport is 'gateway'. */
  gateway?: string;
  /** False when neither a direct key nor a gateway can serve this id. */
  funded: boolean;
  /** The env var that would fund the direct path. */
  keyEnv: string | null;
  /** Declared server-side tools this path runs natively. */
  native: string[];
  /** Declared server-side tools this path cannot run — they are omitted. */
  dropped: string[];
  /** Declared client-side tools; portable across every path. */
  portable: string[];
}

export function describeCapabilities(
  model: string,
  tools: readonly string[] = [],
  opts: { callerKey?: boolean } = {},
): CapabilityReport {
  const plan = planTransport(model, opts);
  const native: string[] = [];
  const dropped: string[] = [];
  const portable: string[] = [];
  for (const name of tools) {
    const providers = SERVER_SIDE_TOOLS[name];
    if (!providers) {
      portable.push(name);
    } else if (plan.transport === 'direct' && providers.includes(plan.provider)) {
      native.push(name);
    } else {
      dropped.push(name);
    }
  }
  return {
    model,
    provider: plan.provider,
    providerLabel: PROVIDERS[plan.provider].label,
    transport: plan.transport,
    ...(plan.gateway ? { gateway: plan.gateway.id } : {}),
    funded: plan.funded,
    keyEnv: plan.keyEnv,
    native,
    dropped,
    portable,
  };
}

/**
 * One line for a startup log, or undefined when there is nothing to say —
 * a funded direct path with no dropped tool is the quiet default.
 */
export function capabilitySummary(agentName: string, r: CapabilityReport): string | undefined {
  if (!r.funded) {
    return `${agentName}: ${r.model} has no route — set ${r.keyEnv ?? 'a provider key'} (or a MODEL_GATEWAY).`;
  }
  const via = r.transport === 'gateway' ? ` via gateway:${r.gateway}` : '';
  if (r.dropped.length === 0) {
    return via ? `${agentName}: ${r.model}${via}.` : undefined;
  }
  const why =
    r.transport === 'gateway'
      ? 'a gateway cannot enable upstream native search'
      : r.provider === 'ollama'
        ? 'a local model has no native search'
        : `${r.providerLabel} has no native ${r.dropped.join('/')}`;
  return `${agentName}: ${r.model}${via} — dropped ${r.dropped.join(', ')} (${why}).`;
}
