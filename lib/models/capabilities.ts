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

// ── The capability matrix (ADR 0019) ─────────────────────────────────────────
//
// "Multi-model" promises that any provider can run any role, orchestrators
// included. This table states, per resolved path (a direct provider, or the
// gateway transport), what an agent can rely on. Each cell describes what the
// ADAPTER SENDS, not how a given model behaves once it receives the request:
//
//   supported    the feature reaches the provider in its native form
//   degraded     it reaches the provider in a weaker form; `note` names the loss
//   unsupported  the adapter does not send it; `note` says what happens instead
//
// `evidence: 'test'` cells are asserted against the real outgoing request body
// in tests/capabilityMatrix.test.ts, so changing an adapter without changing
// its row fails a test. `evidence: 'adk'` cells are ADK's own Gemini adapter,
// which this repo does not build requests for.

export const CAPABILITIES = [
  'delegation',
  'memory_tools',
  'structured_output',
  'thinking_with_tools',
  'streaming',
  'vision',
  'native_search',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  delegation: 'delegation (subagents as tools)',
  memory_tools: 'memory tools (load_memory)',
  structured_output: 'structured output (outputSchema)',
  thinking_with_tools: 'thinking with tool use',
  streaming: 'token streaming',
  vision: 'image input',
  native_search: 'native web search',
};

export type Support = 'supported' | 'degraded' | 'unsupported';

export interface CapabilityCell {
  support: Support;
  /** What is lost, or what happens instead. Present unless `supported` is the whole story. */
  note?: string;
  evidence: 'test' | 'adk';
}

/** Matrix rows: each direct provider, plus the gateway transport. */
export type MatrixRow = ProviderId | 'gateway';

const ok = (evidence: CapabilityCell['evidence'] = 'test', note?: string): CapabilityCell =>
  note ? { support: 'supported', note, evidence } : { support: 'supported', evidence };
const degraded = (note: string): CapabilityCell => ({ support: 'degraded', note, evidence: 'test' });
const unsupported = (note: string): CapabilityCell => ({ support: 'unsupported', note, evidence: 'test' });

const nativeSearch = (row: ProviderId): CapabilityCell =>
  SERVER_SIDE_TOOLS.web_search.includes(row)
    ? ok(row === 'gemini' ? 'adk' : 'test')
    : unsupported('no native search on this path; the web_search sentinel is dropped (use web_extract)');

const RESPONSES_REASONING_NOTE =
  'reasoning is requested, but reasoning items are not carried across tool calls, so the model re-reasons each step';
const CHAT_THINKING_NOTE =
  'thinkingConfig budgets are ignored on chat-completions; generateContentConfig.reasoningEffort is the lever';

export const CAPABILITY_MATRIX: Record<MatrixRow, Record<Capability, CapabilityCell>> = {
  gemini: {
    delegation: ok('adk'),
    memory_tools: ok('adk'),
    structured_output: ok('adk'),
    thinking_with_tools: ok('adk'),
    streaming: ok('adk'),
    vision: ok('adk'),
    native_search: nativeSearch('gemini'),
  },
  anthropic: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok('test', 'sent as a forced tool call; with a thinking budget the tool is offered under tool_choice auto'),
    thinking_with_tools: unsupported(
      'signed thinking blocks are not replayed on tool loops, which Anthropic requires; give a thinking Claude agent no tools',
    ),
    streaming: ok(),
    vision: unsupported('image parts are dropped from the request; route image work to a Gemini, GPT or vision Ollama agent'),
    native_search: nativeSearch('anthropic'),
  },
  openai: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok(),
    thinking_with_tools: degraded(RESPONSES_REASONING_NOTE),
    streaming: ok(),
    vision: ok('test', 'user-turn images only'),
    native_search: nativeSearch('openai'),
  },
  xai: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok(),
    thinking_with_tools: degraded(RESPONSES_REASONING_NOTE),
    streaming: ok(),
    vision: ok('test', 'user-turn images only'),
    native_search: nativeSearch('xai'),
  },
  ollama: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: degraded('JSON mode only (json_object): the output is JSON but the schema is not enforced'),
    thinking_with_tools: degraded(CHAT_THINKING_NOTE),
    streaming: ok(),
    vision: ok('test', 'needs a vision model, e.g. ollama/qwen3-vl:8b'),
    native_search: nativeSearch('ollama'),
  },
  gateway: {
    delegation: ok(),
    memory_tools: ok(),
    structured_output: ok('test', 'strict json_schema; upstream support varies by model'),
    thinking_with_tools: degraded(CHAT_THINKING_NOTE),
    streaming: ok(),
    vision: ok('test', 'upstream model must accept images'),
    native_search: unsupported('a gateway cannot enable upstream native search; the web_search sentinel is dropped'),
  },
};

/** The matrix cell for a model on the path it will actually take. */
export function capabilityOf(
  model: string,
  capability: Capability,
  opts: { callerKey?: boolean } = {},
): CapabilityCell & { row: MatrixRow } {
  const plan = planTransport(model, opts);
  const row: MatrixRow = plan.transport === 'gateway' ? 'gateway' : plan.provider;
  return { row, ...CAPABILITY_MATRIX[row][capability] };
}

/** What one agent's YAML asks of its model. */
export interface AgentNeedsInput {
  tools?: readonly string[];
  outputSchema?: unknown;
  generateContentConfig?: { thinkingConfig?: { thinkingBudget?: number; includeThoughts?: boolean } };
  /** True when this agent delegates to subagents through tools (DELEGATE mode). */
  delegates?: boolean;
}

export function requiredCapabilities(agent: AgentNeedsInput): Capability[] {
  const tools = agent.tools ?? [];
  const needs = new Set<Capability>();
  if (agent.delegates) needs.add('delegation');
  if (tools.includes('load_memory')) needs.add('memory_tools');
  if (agent.outputSchema) needs.add('structured_output');
  const thinking = agent.generateContentConfig?.thinkingConfig;
  const thinks = !!thinking && (thinking.thinkingBudget ?? 0) !== 0;
  if (thinks && (tools.length > 0 || agent.delegates)) needs.add('thinking_with_tools');
  if (tools.includes('web_search')) needs.add('native_search');
  return [...needs];
}

export interface CapabilityGap {
  capability: Capability;
  support: Exclude<Support, 'supported'>;
  row: MatrixRow;
  note?: string;
}

/** The capabilities an agent needs that its resolved path does not fully give it. */
export function capabilityGaps(
  model: string,
  agent: AgentNeedsInput,
  opts: { callerKey?: boolean } = {},
): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  for (const capability of requiredCapabilities(agent)) {
    const cell = capabilityOf(model, capability, opts);
    if (cell.support === 'supported') continue;
    gaps.push({ capability, support: cell.support, row: cell.row, ...(cell.note ? { note: cell.note } : {}) });
  }
  return gaps;
}

const SUPPORT_MARK: Record<Support, string> = { supported: '✓', degraded: '◐', unsupported: '✗' };

/** The matrix as a Markdown table plus notes, for documentation and the doctor. */
export function renderCapabilityMatrix(): string {
  const rows = Object.keys(CAPABILITY_MATRIX) as MatrixRow[];
  const label = (r: MatrixRow) => (r === 'gateway' ? 'Gateway (any id)' : PROVIDERS[r].label);
  const lines: string[] = [];
  lines.push(`| Capability | ${rows.map(label).join(' | ')} |`);
  lines.push(`|---|${rows.map(() => '---').join('|')}|`);
  const notes: string[] = [];
  for (const cap of CAPABILITIES) {
    const cells = rows.map((r) => {
      const cell = CAPABILITY_MATRIX[r][cap];
      if (!cell.note) return SUPPORT_MARK[cell.support];
      notes.push(`${label(r)} · ${CAPABILITY_LABELS[cap]}: ${cell.note}.`);
      return `${SUPPORT_MARK[cell.support]}${notes.length}`;
    });
    lines.push(`| ${CAPABILITY_LABELS[cap]} | ${cells.join(' | ')} |`);
  }
  lines.push('');
  lines.push('✓ supported · ◐ degraded · ✗ unsupported. Gemini cells are ADK\'s own adapter; every other cell is asserted against the request the adapter sends.');
  lines.push('');
  notes.forEach((n, i) => lines.push(`${i + 1}. ${n}`));
  return lines.join('\n');
}
