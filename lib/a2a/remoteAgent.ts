/**
 * lib/a2a/remoteAgent.ts — call a REMOTE agent over A2A, so a syndicate can
 * delegate to an agent another team, another deployment, or another
 * framework serves. Until this module the framework served A2A but could not
 * call it: two melchizedek deployments could not compose over the protocol
 * they both speak.
 *
 * A YAML subagent opts in with `a2a_agent_url:` (lib/loadSyndicate.ts). It
 * becomes a tool with the same single `request` argument an AgentTool has,
 * so an orchestrator delegates to a remote agent exactly as to a local one;
 * in plan-dispatch it can also be a route (lib/runtime/syndicateTurn.ts).
 *
 * Built on the official A2A SDK client with its v0.3 compatibility layer on,
 * so a remote agent may speak A2A 1.0 (e.g. Microsoft Foundry) or 0.3 (most
 * other platforms today); the card decides. It does not depend on ADK.
 *
 * Security:
 *   - Every URL — the card and the endpoint the card names — passes the
 *     SSRF guard (lib/net/addressGuard.ts). A card is attacker-controlled
 *     input: it must not be able to point the server at an internal host.
 *     ALLOW_PRIVATE_A2A=true permits private hosts for local development.
 *   - Credentials come from A2A_AGENT_TOKENS, a JSON object of
 *     hostname → bearer token (or → an object of headers, e.g. a bearer plus
 *     the X-API-Key another melchizedek server requires), sent only to that
 *     exact host, over https (plain http only to loopback). Never from YAML.
 *   - The remote answer is DATA for the orchestrator, like any tool result.
 */

import { createHash, randomUUID } from 'node:crypto';
import { Role, TaskState } from '@a2a-js/sdk';
import type { AgentCard, Message, Part, Task } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory, RestTransportFactory } from '@a2a-js/sdk/client';
import type { Client } from '@a2a-js/sdk/client';
import { FunctionTool } from '@google/adk';
import type { Schema } from '@google/genai';

import { checkHost } from '../net/addressGuard.ts';
import { currentTurnSignal } from '../runtime/turnControl.ts';

const FETCH_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_TASK_TIMEOUT_MS = 10 * 60 * 1000;
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'rejected']);
const NEEDS_INPUT = new Set(['input-required', 'auth-required']);

export interface RemoteAnswer {
  state: string;
  text: string;
  contextId?: string;
}

/** Headers for a host from A2A_AGENT_TOKENS: exact host, and https — or
 *  plain http to a loopback host, for a local server in development. */
export function a2aAuthHeaders(url: URL, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const raw = env.A2A_AGENT_TOKENS;
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (!raw || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return {};
  let map: unknown;
  try {
    map = JSON.parse(raw);
  } catch {
    console.warn('[A2A client] A2A_AGENT_TOKENS is not a JSON object; calling without credentials');
    return {};
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const host = url.hostname.toLowerCase();
  if (!Object.hasOwn(map, host)) return {};
  const entry = (map as Record<string, unknown>)[host];
  if (typeof entry === 'string' && entry) return { Authorization: `Bearer ${entry}` };
  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry)) if (typeof v === 'string') headers[k] = v;
    return headers;
  }
  return {};
}

async function assertSafe(raw: string, what: string, env: NodeJS.ProcessEnv): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid ${what} URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Unsupported ${what} URL scheme: ${url.protocol}`);
  if (env.ALLOW_PRIVATE_A2A === 'true') return url;
  const reason = await checkHost(url.hostname);
  if (reason) throw new Error(`Refusing ${what} host ${url.hostname}: ${reason} (set ALLOW_PRIVATE_A2A=true for local dev)`);
  return url;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** The card URL for a configured value: a card URL as-is, else the well-known path. */
export function cardUrlFor(configured: string): string {
  if (/\.json(\?|$)/.test(configured)) return configured;
  return `${configured.replace(/\/$/, '')}/.well-known/agent-card.json`;
}

/** Every endpoint URL a card advertises (1.0 `supportedInterfaces` or 0.3 `url` / `additionalInterfaces`). */
export function advertisedEndpoints(card: any): string[] {
  const urls = new Set<string>();
  for (const i of card?.supportedInterfaces ?? []) if (typeof i?.url === 'string') urls.add(i.url);
  if (typeof card?.url === 'string') urls.add(card.url);
  for (const i of card?.additionalInterfaces ?? []) if (typeof i?.url === 'string') urls.add(i.url);
  return [...urls];
}

const textOf = (parts: Part[] | undefined): string =>
  (parts ?? [])
    .map((p) => (p.content?.$case === 'text' ? p.content.value : p.content?.$case === 'data' ? JSON.stringify(p.content.value) : ''))
    .filter(Boolean)
    .join('\n');

/** The answer a result carries: a direct message, the task's artifacts, or
 *  its final status message ([STATUS] lines are progress, not an answer). */
export function answerText(result: Message | Task): string {
  if ('messageId' in result) return textOf(result.parts);
  const artifacts = (result.artifacts ?? []).map((a: { parts: Part[] }) => textOf(a.parts)).filter(Boolean).join('\n\n');
  const status = textOf(result.status?.message?.parts);
  return artifacts || (status.startsWith('[STATUS]') ? '' : status);
}

const STATE_NAMES: Partial<Record<TaskState, string>> = {
  [TaskState.TASK_STATE_SUBMITTED]: 'submitted',
  [TaskState.TASK_STATE_WORKING]: 'working',
  [TaskState.TASK_STATE_COMPLETED]: 'completed',
  [TaskState.TASK_STATE_FAILED]: 'failed',
  [TaskState.TASK_STATE_CANCELED]: 'canceled',
  [TaskState.TASK_STATE_REJECTED]: 'rejected',
  [TaskState.TASK_STATE_INPUT_REQUIRED]: 'input-required',
  [TaskState.TASK_STATE_AUTH_REQUIRED]: 'auth-required',
};

/**
 * A client for one remote agent, on the official A2A SDK client with its
 * v0.3 compatibility on: it speaks to A2A 1.0 and 0.3 peers alike, choosing
 * by the interfaces the card advertises. Every request the SDK makes — the
 * card and every call — goes through `guardedFetch`, which applies the SSRF
 * guard and the per-host credentials.
 */
export class RemoteA2AAgent {
  private client: Client | undefined;
  private card: AgentCard | undefined;
  private readonly env: NodeJS.ProcessEnv;
  readonly configuredUrl: string;

  constructor(configuredUrl: string, env: NodeJS.ProcessEnv = process.env) {
    this.configuredUrl = configuredUrl;
    this.env = env;
  }

  /** fetch for the SDK: SSRF guard on every URL, credentials for its host, no redirects. */
  private guardedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = await assertSafe(href, 'agent', this.env);
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(a2aAuthHeaders(url, this.env))) headers.set(k, v);
    return fetch(url, {
      ...init,
      headers,
      redirect: 'error',
      signal: withTimeout(init?.signal ?? undefined, FETCH_TIMEOUT_MS),
    });
  };

  /** Fetch and check the card once; later calls reuse the client. */
  async resolve(): Promise<{ card: AgentCard; client: Client }> {
    if (this.client && this.card) return { card: this.card, client: this.client };
    const legacyCompat = { enabled: true };
    const resolver = new DefaultAgentCardResolver({ fetchImpl: this.guardedFetch, legacyCompat });
    const cardUrl = cardUrlFor(this.configuredUrl);
    const card = await resolver.resolve(cardUrl, '');
    // The card names its own endpoints; they are remote-controlled input and
    // are checked here, before any call, as well as on every request.
    for (const endpoint of advertisedEndpoints(card)) {
      await assertSafe(new URL(endpoint, cardUrl).href, 'agent endpoint', this.env);
    }
    const factory = new ClientFactory({
      transports: [
        new JsonRpcTransportFactory({ fetchImpl: this.guardedFetch, legacyCompat }),
        new RestTransportFactory({ fetchImpl: this.guardedFetch, legacyCompat }),
      ],
    });
    this.client = await factory.createFromAgentCard(card);
    this.card = card;
    return { card, client: this.client };
  }

  /**
   * Send one message and wait for a terminal state (polling a task that is
   * still working). `contextId` keeps a conversation with the remote agent
   * continuous across calls.
   */
  async send(text: string, opts: { contextId?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<RemoteAnswer> {
    const signal = opts.signal;
    const { client } = await this.resolve();
    const message: Message = {
      messageId: randomUUID(),
      contextId: opts.contextId ?? '',
      taskId: '',
      role: Role.ROLE_USER,
      parts: [{ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    let result = await client.sendMessage({ tenant: '', message, configuration: undefined, metadata: undefined }, { signal });
    const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS);
    const stateOf = (r: Message | Task) => ('messageId' in r ? 'completed' : STATE_NAMES[(r.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED) as TaskState] ?? 'unknown');
    while (!('messageId' in result) && !TERMINAL.has(stateOf(result)) && !NEEDS_INPUT.has(stateOf(result))) {
      if (Date.now() > deadline) throw new Error(`remote task ${result.id} did not finish in time`);
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (signal?.aborted) {
        await client.cancelTask({ tenant: '', id: result.id, metadata: undefined } as any).catch(() => {});
        throw new Error('canceled');
      }
      result = await client.getTask({ tenant: '', id: result.id, historyLength: undefined } as any, { signal });
    }
    return { state: stateOf(result), text: answerText(result), contextId: 'messageId' in result ? result.contextId : result.contextId };
  }
}

/** A stable remote conversation id for (local session, subagent): the same
 *  local conversation keeps talking to the same remote conversation. */
export function remoteContextId(localSessionId: string | undefined, subagentName: string): string | undefined {
  if (!localSessionId) return undefined;
  return `melch-${createHash('sha256').update(`${localSessionId}\u0000${subagentName}`).digest('hex').slice(0, 32)}`;
}

/** Render a remote result as the tool output the orchestrator reads. */
export function remoteToolOutput(name: string, answer: RemoteAnswer): string {
  if (answer.state === 'completed') return answer.text || `${name} returned no text.`;
  if (NEEDS_INPUT.has(answer.state)) return `${name} needs more input before it can answer: ${answer.text || '(no detail)'}`;
  return `Error: remote agent ${name} ended in state '${answer.state}'${answer.text ? ` — ${answer.text}` : ''}.`;
}

/**
 * The subagent as a tool with AgentTool's contract (one `request` string), so
 * an orchestrator delegates to it exactly as to a local subagent. Failures
 * come back as readable text, never as a throw into the runner.
 */
export function remoteAgentTool(params: { name: string; description: string; url: string }): FunctionTool {
  const client = new RemoteA2AAgent(params.url);
  return new FunctionTool({
    name: params.name,
    description: params.description || `Remote agent ${params.name}`,
    parameters: {
      type: 'OBJECT',
      properties: { request: { type: 'STRING', description: `What to ask ${params.name}.` } },
      required: ['request'],
    } as unknown as Schema,
    execute: async (input: unknown, toolContext?: any) => {
      const args = (input ?? {}) as { request?: string };
      const request = String(args?.request ?? '').trim();
      if (!request) return `Error: ${params.name} needs a request.`;
      try {
        const answer = await client.send(request, {
          contextId: remoteContextId(toolContext?.invocationContext?.session?.id, params.name),
          signal: currentTurnSignal(),
        });
        return remoteToolOutput(params.name, answer);
      } catch (err: unknown) {
        return `Error: remote agent ${params.name} could not be reached (${err instanceof Error ? err.message : String(err)}).`;
      }
    },
  });
}
