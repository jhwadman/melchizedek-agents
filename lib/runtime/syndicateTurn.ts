/**
 * lib/runtime/syndicateTurn.ts — ONE implementation of "run a syndicate for
 * one user message". The A2A server, the terminal REPL, the background
 * worker and the observatory's eval harness all call `runSyndicateTurn`, and
 * so does a package consumer embedding the engine.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The turn semantics that make the framework work — plan-dispatch with
 * deterministic overrides, the classifier's transcript digest, the projected
 * session a dispatch route reads, the DELEGATE relay fallback, post-answer
 * guards — used to live inside the A2A server's executor, welded to the A2A
 * event bus. The eval harness carried a second copy ("reimplemented, same
 * rule"), and the REPL a third compiler that ignored dispatch, nesting and
 * guards altogether. Three copies of one behaviour drift; this file is the
 * one copy. Surfaces differ only in what they do with the result: the server
 * publishes A2A events, the REPL prints, the harness records.
 *
 * It is also the seam that keeps Google ADK an implementation detail: a
 * caller hands in YAML config and plain text parts and gets plain data back.
 * The ADK Runner, LlmAgent and event shapes stay on this side of the line.
 *
 * ── Controls ──────────────────────────────────────────────────────────────
 * Every turn runs under a TurnControl (lib/runtime/turnControl.ts): the
 * YAML's `max_steps` caps model calls across the WHOLE turn (orchestrator,
 * subagents, nested syndicates), an optional deadline bounds wall-clock
 * time, and an outer AbortSignal cancels it. All three abort the provider
 * request in flight, not just the loop around it.
 */

import { InMemorySessionService, Runner, StreamingMode, getFunctionCalls, getFunctionResponses } from '@google/adk';
import type { BaseMemoryService, BaseSessionService, Event, LlmAgent } from '@google/adk';

import { compileGraph, compileSubagent } from '../compile.ts';
import type { CompileOptions } from '../compile.ts';
import { isDispatchSyndicate, matchRouteOverride, resolveRoute } from '../dispatch.ts';
import type { RouteResolution } from '../dispatch.ts';
import { collectGrounding, describeGrounding, newGroundingState, webSourcesLine } from '../grounding.ts';
import { resolveGuards } from '../guards/index.ts';
import { collectGuards } from '../loadSyndicate.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from '../loadSyndicate.ts';
import { registerAvailableProviders } from '../models/registry.ts';
import { traceAgentRun } from '../observability/tracer.ts';
import { ProjectedSessionService, renderTranscriptDigest } from '../session/transcript.ts';
import { RemoteA2AAgent, remoteContextId, remoteToolOutput } from '../a2a/remoteAgent.ts';
import { createTurnControl, runWithTurnControl, stopCode, stopMessage } from './turnControl.ts';
import type { TurnStopReason } from './turnControl.ts';

// ── Public types ─────────────────────────────────────────────────────────────

/** One part of the user's message. Text is the common case; the genai part
 *  shapes (inlineData, fileData) pass through to the model unchanged. */
export type MessagePart = { text: string } | Record<string, unknown>;

/** Callbacks a surface uses to watch a turn. All optional. */
export interface TurnEvents {
  /** Short human-readable progress lines: tool calls, the chosen route, guard
   *  notes, web sources. The A2A server publishes these as `[STATUS]` lines. */
  onProgress?(text: string): void;
  /** Every raw event of the answering agent, in order (the REPL prints them). */
  onEvent?(event: Event): void;
  /** Diagnostic lines (the server prefixes and prints them). */
  log?(message: string): void;
  warn?(message: string): void;
}

export interface TraceOptions {
  /** Root-span name and `syndicate.name`. Default: config.syndicate_name. */
  syndicateName?: string;
  bindings?: Record<string, unknown>;
  taskId?: string;
  /** Resolved-config digest (lib/observability/lineage.ts). */
  configHash?: string;
  /** Extra root-span attributes (surface headers, eval tags). */
  attributes?: Record<string, string | number | boolean>;
  onSpanStart?: (ids: { traceId: string; spanId: string }) => void;
}

export interface SyndicateTurnOptions {
  config: SyndicateYamlConfig;
  /** The user's message. */
  parts: MessagePart[];
  /** Session coordinates. The session is created if it does not exist. */
  appName: string;
  userId: string;
  sessionId: string;
  sessionService: BaseSessionService;
  /** Handed to the Runner so `load_memory` / `preload_memory` can recall. */
  memoryService?: BaseMemoryService;
  /** Model resolution, unknown-tool handling, nested loading. */
  compile?: CompileOptions;
  /** Applied to every compiled agent before it runs (eval tool replay). */
  transformAgent?: (agent: LlmAgent) => LlmAgent;
  /** Plan-dispatch only: skip the classifier and run this route. Overrides
   *  in the YAML still win, as they do in production. */
  forceRoute?: string;
  /** Cancels the turn when aborted. */
  signal?: AbortSignal;
  /** Wall-clock budget for the turn, in ms. Default: none. */
  deadlineMs?: number;
  /** Model-call ceiling for the whole turn. Default: the YAML's `max_steps`. */
  maxLlmCalls?: number;
  /** Ask adapters for token-by-token partial events (the REPL's live view). */
  streaming?: boolean;
  /** Root-span metadata; `false` disables tracing for the turn. */
  trace?: TraceOptions | false;
  events?: TurnEvents;
}

/** What one agent's event stream amounted to. */
export interface DrainedRun {
  /** The answer: the LAST event's non-thinking text (partials append). */
  text: string;
  /** Last plain-text tool result — the DELEGATE relay fallback. */
  lastToolResultText: string;
  /** Every plain-text tool result, whole, in order — what guards check. */
  toolResultTexts: string[];
  invokedToolNames: Set<string>;
  toolCalls: Array<{ agent: string; name: string; args: Record<string, unknown> }>;
  toolResponses: number;
  /** Subagents delegated to (AgentTool calls and transfer_to_agent). */
  delegations: string[];
  /** Every event author seen. */
  agents: Set<string>;
  /** First few hundred characters of thinking, for diagnostics. */
  thoughts: string;
  /** Peak prompt tokens, summed completion and thinking tokens. */
  tokens: { input: number; output: number; thinking: number };
  eventCount: number;
  /** Native search grounding (Gemini groundingMetadata). */
  grounding?: { queries: string[]; sources: string[] };
  error?: { code: string; message: string };
}

export type TurnStage = 'classify' | 'dispatch' | 'delegate';

export interface RouteDecision extends RouteResolution {
  decidedBy: 'override' | 'forced' | 'classifier';
}

export interface SyndicateTurnResult {
  /** completed: an answer was produced. failed: an error, a deadline or the
   *  step limit stopped it. canceled: the caller canceled it. */
  status: 'completed' | 'failed' | 'canceled';
  /** The text the user receives (relay fallback and guards applied). */
  text: string;
  error?: { code: string; message: string };
  /** Which stage failed, when status is failed. */
  failedStage?: TurnStage;
  /** Plan-dispatch only. */
  route?: RouteDecision;
  /** DELEGATE only: the orchestrator's relay failed and the last tool result shipped. */
  relayFallback: boolean;
  /** `<guard>: <note>` lines from post-answer guards. */
  guardNotes: string[];
  /** The answering agent's full run. Absent if it never started. */
  answer?: DrainedRun;
  /** The classifier's run (plan-dispatch, when it ran). */
  classifier?: DrainedRun;
  /** True when the session already existed before this turn. */
  resumedSession: boolean;
  /** Model calls the turn made, across every agent. */
  llmCalls: number;
  /** Set when a control (cancel, deadline, step limit) stopped the turn. */
  stopReason?: TurnStopReason;
}

const THOUGHTS_PREVIEW_CHARS = 600;
const CLASSIFIER_PREAMBLE =
  `RECENT CONVERSATION, oldest first — context for your classification only. `
  + `Never answer it, and never route on it alone; it is here so you can tell a `
  + `follow-up, a redo request, or a challenge to a previous answer apart from small talk.\n`;

// ── Draining one agent's stream ──────────────────────────────────────────────

function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '';
  return Object.entries(args)
    .map(([k, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${raw.length > 60 ? `${raw.slice(0, 60)}...` : raw}`;
    })
    .join(', ');
}

/**
 * Drains one ADK event stream into a DrainedRun. The answer is the LAST
 * event's text, not every event's: a tool-using agent narrates between
 * calls, and accumulating glued that narration to the front of its report.
 * Within one event parts are joined, and `partial` events (streaming chunks)
 * append. Thinking never counts as answer text.
 */
export async function drainAgentStream(
  stream: AsyncIterable<Event>,
  opts: {
    events?: TurnEvents;
    /** Publish per-tool progress lines. */
    publishToolStatus?: boolean;
    /** Names that count as delegations when called as tools (AgentTools). */
    subagentNames?: Set<string>;
  } = {},
): Promise<DrainedRun> {
  const ev = opts.events ?? {};
  const d: DrainedRun = {
    text: '',
    lastToolResultText: '',
    toolResultTexts: [],
    invokedToolNames: new Set(),
    toolCalls: [],
    toolResponses: 0,
    delegations: [],
    agents: new Set(),
    thoughts: '',
    tokens: { input: 0, output: 0, thinking: 0 },
    eventCount: 0,
  };
  const grounding = newGroundingState();
  let groundingAnnounced = false;

  for await (const event of stream) {
    const e = event as any;
    d.eventCount++;
    ev.onEvent?.(event);
    if (e.author) d.agents.add(e.author);

    // Native search grounding rides on the model event, not on a tool call.
    if (collectGrounding(e, grounding)) {
      const firstSight = grounding.queries.size + grounding.sources.size > 0 && !groundingAnnounced;
      ev.log?.(`⌕ Grounding: ${describeGrounding(grounding)}`);
      // Same shape as a function-tool line so consumers that parse
      // "Invoking tool:" (nihilistic-penguin RouteTrace) list it.
      if (opts.publishToolStatus && firstSight) ev.onProgress?.('Invoking tool: web_search');
      groundingAnnounced = true;
    }

    if ((e.errorCode || e.errorMessage) && e.errorCode !== 'STOP') {
      d.error = { code: String(e.errorCode ?? 'ERROR'), message: String(e.errorMessage ?? '') };
      ev.warn?.(`Error [${d.error.code}]: ${d.error.message}`);
      break;
    }

    if (e.usageMetadata) {
      // Same aggregation as traceAgentRun: peak prompt, summed completions.
      d.tokens.input = Math.max(d.tokens.input, e.usageMetadata.promptTokenCount ?? 0);
      d.tokens.output += e.usageMetadata.candidatesTokenCount ?? 0;
      d.tokens.thinking += e.usageMetadata.thoughtsTokenCount ?? 0;
    }

    for (const call of getFunctionCalls(event) ?? []) {
      const name = call.name ?? '';
      const args = (call.args ?? {}) as Record<string, unknown>;
      if (name === 'transfer_to_agent') {
        const target = String((args as any).agentName ?? 'unknown');
        d.delegations.push(target);
        ev.log?.(`→ Delegating to: ${target}`);
        if (opts.publishToolStatus) ev.onProgress?.(`Delegating to subagent: ${target}`);
        continue;
      }
      if (!name) continue;
      d.invokedToolNames.add(name);
      if (opts.subagentNames?.has(name)) d.delegations.push(name);
      d.toolCalls.push({ agent: e.author ?? 'unknown', name, args });
      ev.log?.(`→ Tool: ${name}(${formatToolArgs(args)})`);
      if (opts.publishToolStatus) ev.onProgress?.(`Invoking tool: ${name}`);
    }

    for (const resp of getFunctionResponses(event) ?? []) {
      const r = resp as any;
      const name: string = r.name ?? r.functionResponse?.name ?? '';
      const content = r.response ?? r.functionResponse?.response ?? {};
      d.toolResponses++;
      if (name) d.invokedToolNames.add(name);
      const asString = typeof content === 'string' ? content : JSON.stringify(content);
      ev.log?.(`← Result: ${name || 'unknown'} — ${asString.length.toLocaleString()} chars`);
      // Only plain text results are relayable answers — a structured or
      // base64 payload (image tools) is not.
      const resultText =
        typeof content === 'string'
          ? content
          : typeof content?.result === 'string'
            ? content.result
            : '';
      if (resultText.trim()) {
        d.lastToolResultText = resultText.trim();
        d.toolResultTexts.push(resultText.trim());
      }
    }

    let eventText = '';
    for (const part of event.content?.parts ?? []) {
      const p = part as any;
      if (!p.text) continue;
      if (p.thought === true) {
        if (d.thoughts.length < THOUGHTS_PREVIEW_CHARS) d.thoughts += p.text;
      } else {
        eventText += p.text;
      }
    }
    if (eventText) d.text = e.partial === true ? d.text + eventText : eventText;
  }

  const sourcesLine = webSourcesLine(grounding);
  // A consumer contract (penguin RouteTrace `_SOURCES_RE`): "Web sources: a, b",
  // published once, after the stream, with the full set.
  if (opts.publishToolStatus && sourcesLine) ev.onProgress?.(sourcesLine);
  if (grounding.queries.size || grounding.sources.size) {
    d.grounding = { queries: [...grounding.queries], sources: [...grounding.sources] };
  }
  d.text = d.text.trim();
  return d;
}

/** True when an orchestrator's text is just the name of a tool it called —
 *  the degenerate relay ("FinancialAnalyst", 3 tokens). Deliberately narrow:
 *  short real answers are legitimate, so no length heuristic. */
export function echoesToolName(text: string, toolNames: Iterable<string>): boolean {
  const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!text) return false;
  for (const name of toolNames) if (normalize(name) === normalize(text)) return true;
  return false;
}

// ── The turn ─────────────────────────────────────────────────────────────────

/**
 * Runs one user message through a syndicate and returns what the user
 * receives. Never throws for model or tool failures — those come back as
 * `status: 'failed'` with an error. It throws only for programming errors
 * (a session service that rejects, a config naming a route it does not
 * declare), which a surface should treat as an internal error.
 */
export async function runSyndicateTurn(opts: SyndicateTurnOptions): Promise<SyndicateTurnResult> {
  const { config } = opts;
  // A model id given as a string resolves through ADK's LLMRegistry. Without
  // the framework's adapters registered there, Gemini would be ADK's own
  // class, which bypasses traceLlmGeneration: no max_steps, no cancel. A
  // caller that resolves models itself (the A2A server) is left alone.
  if (!opts.compile?.resolveModel) registerAvailableProviders();
  const control = createTurnControl({
    maxLlmCalls: opts.maxLlmCalls ?? config.max_steps,
    deadlineMs: opts.deadlineMs,
    signal: opts.signal,
  });
  try {
    return await runWithTurnControl(control, () => runTurnInner(opts, control));
  } finally {
    control.dispose();
  }
}

async function runTurnInner(
  opts: SyndicateTurnOptions,
  control: ReturnType<typeof createTurnControl>,
): Promise<SyndicateTurnResult> {
  const { config, appName, userId, sessionId, sessionService } = opts;
  const ev = opts.events ?? {};
  const compileOpts: CompileOptions = opts.compile ?? {};
  const transform = opts.transformAgent ?? ((a: LlmAgent) => a);
  const subagentNames = new Set((config.subagents ?? []).map((s) => s.name));
  const trace = opts.trace === false ? undefined : opts.trace ?? {};
  const parts = opts.parts.map((p) => (typeof p === 'string' ? { text: p } : p));
  const messageText = parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('\n');

  const result: SyndicateTurnResult = {
    status: 'completed',
    text: '',
    relayFallback: false,
    guardNotes: [],
    resumedSession: false,
    llmCalls: 0,
  };
  const finish = (): SyndicateTurnResult => {
    result.llmCalls = control.llmCalls;
    if (control.stopReason) {
      result.stopReason = control.stopReason;
      result.status = control.stopReason === 'canceled' ? 'canceled' : 'failed';
      result.error = { code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) };
    }
    return result;
  };

  // ── Session ────────────────────────────────────────────────────────────────
  const existing = await sessionService.getSession({ appName, userId, sessionId });
  if (existing) {
    result.resumedSession = true;
  } else {
    await sessionService.createSession({ appName, userId, sessionId });
  }

  /** Run ONE agent against ONE session, under the turn's controls. */
  const runAgent = async (params: {
    agent: LlmAgent;
    sid: string;
    userParts: any[];
    sessions: BaseSessionService;
    stage: TurnStage;
    route?: RouteResolution;
    publishToolStatus: boolean;
    /** Evaluated at span end: did the DELEGATE relay fall back? */
    relayFallback?: () => boolean;
  }): Promise<DrainedRun> => {
    const runner = new Runner({
      agent: params.agent,
      appName,
      sessionService: params.sessions,
      ...(opts.memoryService ? { memoryService: opts.memoryService } : {}),
    });
    let stream: AsyncIterable<Event> = runner.runAsync({
      userId,
      sessionId: params.sid,
      newMessage: { role: 'user', parts: params.userParts },
      abortSignal: control.signal,
      ...(opts.streaming ? { runConfig: { streamingMode: StreamingMode.SSE } as any } : {}),
    });
    if (trace) {
      stream = traceAgentRun(stream as AsyncIterableIterator<Event>, {
        syndicateName: trace.syndicateName ?? config.syndicate_name ?? appName,
        bindings: trace.bindings ?? config.variables ?? {},
        input: params.userParts,
        route: params.route,
        // Identity: the CONVERSATION id, not the classifier's throwaway lane —
        // every stage of one turn shares session and task ids.
        sessionId,
        userId,
        taskId: trace.taskId,
        stage: params.stage,
        configHash: trace.configHash,
        attributes: trace.attributes,
        onSpanStart: trace.onSpanStart,
        onEnd: () => ({
          'syndicate.relay_fallback': params.stage === 'delegate' && !!params.relayFallback?.(),
          ...(control.stopReason ? { 'syndicate.stop_reason': control.stopReason } : {}),
          'syndicate.llm_calls': control.llmCalls,
        }),
      });
    }
    try {
      return await drainAgentStream(stream, {
        events: params.stage === 'classify' ? { ...ev, onEvent: undefined } : ev,
        publishToolStatus: params.publishToolStatus,
        subagentNames,
      });
    } catch (err) {
      // A provider call aborted by cancel / deadline surfaces as a thrown
      // AbortError. That is a stop, not a crash.
      if (control.stopReason) {
        return emptyRun({ code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) });
      }
      throw err;
    }
  };

  let answer: DrainedRun;

  if (isDispatchSyndicate(config)) {
    // ══ PLAN ═════════════════════════════════════════════════════════════
    // Deterministic overrides first: when the message itself decides the
    // route there is nothing to classify, and the classifier call is skipped.
    const warnings: string[] = [];
    let resolution: RouteResolution | null = matchRouteOverride(messageText, config, warnings);
    let decidedBy: RouteDecision['decidedBy'] = 'override';
    for (const w of warnings) ev.warn?.(w);

    if (resolution) {
      ev.log?.(`⇄ Route pinned by override: ${resolution.route}`);
    } else if (opts.forceRoute) {
      if (!subagentNames.has(opts.forceRoute)) {
        throw new Error(`forceRoute '${opts.forceRoute}' is not a declared subagent`);
      }
      resolution = { route: opts.forceRoute, reason: 'forced by the caller', fellBack: false, fallbackReason: '', viaOverride: false };
      decidedBy = 'forced';
    } else {
      decidedBy = 'classifier';
      // The classifier reads the SHARED transcript as an input digest and runs
      // in a throwaway in-memory lane, so its JSON verdicts never enter the
      // conversation the next specialist reads.
      const routerAgent = transform(await compileGraph(config, compileOpts));
      const routerSid = `${sessionId}::route`;
      const routerSessions = new InMemorySessionService();
      await routerSessions.createSession({ appName, userId, sessionId: routerSid });
      const shared = await sessionService.getSession({ appName, userId, sessionId });
      const digest = renderTranscriptDigest(shared?.events ?? []);
      const routerParts = digest
        ? [{ text: `${CLASSIFIER_PREAMBLE}${digest}\n\n--- MESSAGE TO CLASSIFY ---\n${messageText}` }]
        : parts;
      const plan = await runAgent({
        agent: routerAgent,
        sid: routerSid,
        userParts: routerParts,
        sessions: routerSessions,
        stage: 'classify',
        publishToolStatus: false,
      });
      result.classifier = plan;
      if (control.stopReason) return finish();
      // Fail-static: a dead classifier costs the user a good route, never
      // their answer. An empty payload resolves to default_route.
      resolution = resolveRoute(plan.error ? '' : plan.text, config);
      if (plan.error) {
        ev.warn?.(`Router failed [${plan.error.code}] — defaulting to '${resolution.route}'.`);
      } else if (resolution.fellBack) {
        ev.warn?.(`Routing fell back to '${resolution.route}': ${resolution.fallbackReason}`);
      }
    }

    const routeCfg: SubagentYamlConfig | undefined = (config.subagents ?? []).find((s) => s.name === resolution!.route);
    if (!routeCfg) throw new Error(`Dispatch failed: no subagent named '${resolution.route}' is declared.`);
    result.route = { ...resolution, decidedBy };
    const routeNote = resolution.reason ? ` — ${resolution.reason}` : '';
    ev.log?.(`⇄ Route: ${resolution.route}${routeNote}`);
    ev.onProgress?.(`Routed to ${resolution.route}${routeNote}`);

    // ══ DISPATCH ═════════════════════════════════════════════════════════
    if (routeCfg.a2a_agent_url) {
      // A remote route answers over A2A; its conversation id is derived from
      // this one, so follow-ups reach the same remote conversation.
      answer = await runRemoteRoute(routeCfg.name, routeCfg.a2a_agent_url, messageText, sessionId, control, ev);
    } else {
      // The route answers directly in the SHARED session, read through a
      // projection: ADK would otherwise render other agents' turns as user
      // speech mixed with their tool payloads (lib/session/transcript.ts).
      const routeAgent = transform(await compileSubagent(routeCfg, compileOpts));
      answer = await runAgent({
        agent: routeAgent,
        sid: sessionId,
        userParts: parts,
        sessions: new ProjectedSessionService(sessionService, routeCfg.name),
        stage: 'dispatch',
        route: resolution,
        publishToolStatus: true,
      });
    }
    result.answer = answer;
    if (answer.error || control.stopReason) {
      result.status = 'failed';
      result.failedStage = 'dispatch';
      result.error = answer.error;
      return finish();
    }
    result.text = answer.text;
    if (!result.text) {
      // Naming the route turns a blank reply into a lead (the XScout outage
      // shape: the specialist ran and returned nothing because its provider
      // rejected the call upstream).
      ev.warn?.(`Route '${resolution.route}' produced no output.`);
      result.text = `${resolution.route} returned no output — the server logs carry the upstream error.`;
    }
  } else {
    // ══ DELEGATE ═════════════════════════════════════════════════════════
    // Subagents are AgentTools; the orchestrator relays the answer it got.
    const orchestrator = transform(await compileGraph(config, compileOpts));
    let drained: DrainedRun | undefined;
    answer = await runAgent({
      agent: orchestrator,
      sid: sessionId,
      userParts: parts,
      sessions: sessionService,
      stage: 'delegate',
      publishToolStatus: true,
      relayFallback: () =>
        !!drained && (!drained.text || echoesToolName(drained.text, drained.invokedToolNames)) && !!drained.lastToolResultText,
    });
    drained = answer;
    result.answer = answer;
    if (answer.error || control.stopReason) {
      result.status = 'failed';
      result.failedStage = 'delegate';
      result.error = answer.error;
      return finish();
    }
    result.text = answer.text;
    // Failed-relay fallback: an orchestrator can botch the hop that relays a
    // specialist's answer — STOP with no text, or the bare tool NAME as its
    // text. Both discard a fully-formed result, so the last tool result is
    // returned deterministically instead of retrying the relay.
    const echoed = echoesToolName(result.text, answer.invokedToolNames);
    if ((!result.text || echoed) && answer.lastToolResultText) {
      ev.warn?.(
        `Orchestrator ${echoed ? `echoed the tool name ("${result.text}")` : 'emitted no text'} — `
        + `relaying last tool result verbatim (${answer.lastToolResultText.length.toLocaleString()} chars).`,
      );
      result.text = answer.lastToolResultText;
      result.relayFallback = true;
    }
  }

  // ══ GUARDS ═══════════════════════════════════════════════════════════════
  // Named in the syndicate's `guards:` list (and any nested syndicate's). They
  // REWRITE rather than retry, on the answering turn's text with every tool
  // result it produced. The classifier never reaches here.
  const guardNames = collectGuards(config);
  if (result.text && guardNames.length) {
    const inputs = answer.toolResultTexts;
    for (const guard of resolveGuards(guardNames, (n) => ev.warn?.(`Unknown guard '${n}' — ignored`))) {
      try {
        const out = await guard.run(result.text, inputs);
        // Always logged, notes or not: a guard that ran clean must be
        // distinguishable from one that never ran.
        ev.log?.(`⛨ ${guard.name}: checked ${result.text.length.toLocaleString()} chars against ${inputs.length} tool result${inputs.length === 1 ? '' : 's'} — ${out.notes.length} note${out.notes.length === 1 ? '' : 's'}`);
        for (const note of out.notes) {
          ev.log?.(`⛨ ${guard.name}: ${note}`);
          ev.onProgress?.(`Guard ${guard.name}: ${note}`);
          result.guardNotes.push(`${guard.name}: ${note}`);
        }
        result.text = out.text;
      } catch (guardErr: unknown) {
        const msg = guardErr instanceof Error ? guardErr.message : String(guardErr);
        ev.warn?.(`Guard '${guard.name}' failed (answer shipped unguarded): ${msg}`);
        ev.onProgress?.(`Guard ${guard.name}: did not run (${msg})`);
        result.guardNotes.push(`${guard.name}: did not run (${msg})`);
      }
    }
  }

  return finish();
}

/** A plan-dispatch route that is a remote A2A agent (`a2a_agent_url`). */
async function runRemoteRoute(
  name: string,
  url: string,
  messageText: string,
  sessionId: string,
  control: ReturnType<typeof createTurnControl>,
  ev: TurnEvents,
): Promise<DrainedRun> {
  ev.onProgress?.(`Invoking remote agent: ${name}`);
  try {
    const answer = await new RemoteA2AAgent(url).send(messageText, {
      contextId: remoteContextId(sessionId, name),
      signal: control.signal,
    });
    const run = emptyRun();
    run.agents.add(name);
    run.delegations.push(name);
    if (answer.state === 'completed') {
      run.text = answer.text;
    } else {
      run.error = { code: `REMOTE_${answer.state.toUpperCase().replace(/-/g, '_')}`, message: remoteToolOutput(name, answer) };
    }
    return run;
  } catch (err: unknown) {
    if (control.stopReason) return emptyRun({ code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) });
    return emptyRun({ code: 'REMOTE_UNREACHABLE', message: `${name}: ${err instanceof Error ? err.message : String(err)}` });
  }
}

function emptyRun(error?: { code: string; message: string }): DrainedRun {
  return {
    text: '',
    lastToolResultText: '',
    toolResultTexts: [],
    invokedToolNames: new Set(),
    toolCalls: [],
    toolResponses: 0,
    delegations: [],
    agents: new Set(),
    thoughts: '',
    tokens: { input: 0, output: 0, thinking: 0 },
    eventCount: 0,
    ...(error ? { error } : {}),
  };
}

// ── Long-term memory after a turn ────────────────────────────────────────────

/** A memory service that can take per-syndicate extraction rules (the
 *  Supabase service does; the base interface does not declare them). */
interface RuledMemoryService extends BaseMemoryService {
  addSessionToMemory(session: any, extractionRules?: string): Promise<void>;
}

/**
 * Distils the conversation into long-term memory. Call it after the answer
 * has been delivered — it never delays the reply, and a failure here never
 * fails the turn. Returns false when there was nothing to ingest.
 */
export async function ingestTurnMemory(params: {
  memoryService: BaseMemoryService;
  sessionService: BaseSessionService;
  appName: string;
  userId: string;
  sessionId: string;
  extractionRules?: string;
}): Promise<boolean> {
  const session = await params.sessionService.getSession({
    appName: params.appName,
    userId: params.userId,
    sessionId: params.sessionId,
  });
  if (!session || session.events.length === 0) return false;
  await (params.memoryService as RuledMemoryService).addSessionToMemory(session, params.extractionRules);
  return true;
}
