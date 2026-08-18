import express from 'express';
import rateLimit from 'express-rate-limit';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import { timingSafeEqual, createHash } from 'node:crypto';
import { loadEnv } from '../lib/loadEnv.ts';
import {
  DefaultRequestHandler, 
  InMemoryTaskStore, 
  RequestContext
} from '@a2a-js/sdk/server';
import type { AgentExecutor, ExecutionEventBus } from '@a2a-js/sdk/server';
import { AsyncLocalStorage } from 'async_hooks';
import { agentCardHandler, jsonRpcHandler, restHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { Runner, LlmAgent, AgentTool, InMemorySessionService, getFunctionCalls, getFunctionResponses, setLogLevel, LogLevel } from '@google/adk';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig, SubagentYamlConfig } from '../lib/loadSyndicate.ts';
import { isDispatchSyndicate, matchRouteOverride, resolveRoute } from '../lib/dispatch.ts';
import { traceAgentRun } from '../lib/observability/tracer.ts';
import { resolveModel } from '../lib/models/registry.ts';
import { resolveTools as resolveNamedTools } from '../lib/toolRegistry.ts';
import { createMcpTools } from '../lib/tools/mcpToolFactory.ts';
import { hasSupabaseCredentials, createSupabaseServices } from '../lib/persistence/supabaseProvider.ts';
import { ProjectedSessionService, renderTranscriptDigest } from '../lib/session/transcript.ts';
import type { BaseSessionService, BaseMemoryService } from '@google/adk';
import type { SupabaseVectorMemoryService } from '../lib/memory/supabaseMemoryService.ts';

interface A2AContext {
  apiKey: string;
  provider: string;
  /** Optional end-user identifier supplied via X-User-Id (validated in middleware). */
  siteUserId?: string;
}
const requestContextStorage = new AsyncLocalStorage<A2AContext>();

const A2A_APP_NAME = 'melchizedek-a2a';

/** X-User-Id must be short and filesystem/key-safe; anything else is rejected. */
const SITE_USER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Memory/session silo derivation.
 * Base silo: a hash of the caller's API key (one bucket per credential).
 * With X-User-Id, the end-user is siloed BENEATH the key hash — so a site
 * proxying many humans through one backend key gets one bucket per human,
 * and no site can ever reach into another credential's buckets, because
 * the key hash always prefixes.
 */
function deriveUserId(ctx: A2AContext): string {
  const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex').slice(0, 16);
  return ctx.siteUserId ? `a2a-${keyHash}/${ctx.siteUserId}` : `a2a-${keyHash}`;
}

// ── Dynamic Agent Card Compiler ──────────────────────────────────────────
// Synthesizes the public card configuration from current registry variables
function compileAgentCard(config: SyndicateYamlConfig): AgentCard {
  const orchestratorConfig = config.orchestrator;
  const subagents = config.subagents || [];
  const url = process.env.PUBLIC_URL || 'http://localhost:4000';

  return {
    name: orchestratorConfig.name,
    description: orchestratorConfig.description || 'Syndicate Orchestrator Agent',
    protocolVersion: '0.3.0',
    version: '2.0.0',
    url: `${url}/a2a/jsonrpc`,
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: true
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: subagents.map(sub => ({
      id: sub.name,
      name: sub.name,
      description: sub.description || 'Subagent collaborator',
      tags: sub.tools || []
    })),
    additionalInterfaces: [
      { url: `${url}/a2a/jsonrpc`, transport: 'JSONRPC' },
      { url: `${url}/a2a/rest`, transport: 'HTTP+JSON' }
    ]
  };
}

// ── Log Formatting Helpers ────────────────────────────────────────────────
// Summarises tool call args into a single readable string, truncating long values.
function formatToolArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '';
  return Object.entries(args)
    .map(([k, v]) => {
      const raw = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${raw.length > 60 ? `${raw.slice(0, 60)}...` : raw}`;
    })
    .join(', ');
}

// ── Progress telemetry ────────────────────────────────────────────────────
// `[STATUS]` is a consumer contract, not decoration: A2A clients scan task
// history for messages carrying this prefix and surface them as live progress
// (the Discord bot edits its "Considering your query..." placeholder with the
// newest one). Keep these lines short and human-readable — they are read by a
// person waiting for an answer, not by a parser.
function publishWorking(
  eventBus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  text: string,
): void {
  eventBus.publish({
    kind: 'status-update',
    taskId,
    contextId,
    status: {
      state: 'working',
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'agent',
        parts: [{ kind: 'text', text: `[STATUS] ${text}` }],
        contextId,
        taskId
      },
      timestamp: new Date().toISOString()
    },
    final: false
  } as any);
}

/** Outcome of running one agent for one turn. See SyndicateExecutor.runTurn. */
interface TurnResult {
  /** Concatenated non-thinking text the agent emitted. */
  text: string;
  /** Last plain-text tool result seen — the DELEGATE-mode relay fallback. */
  lastToolResultText: string;
  /** Every tool/subagent name invoked, for degenerate-output detection. */
  invokedToolNames: Set<string>;
  /** Pre-rendered " | N tokens (M thinking)" log suffix, or ''. */
  tokenInfo: string;
  /** Set when an error event ended the run early. */
  error?: { code: string; message: string };
  /** Native web-search grounding the model used (Gemini groundingMetadata):
   *  the queries it ran and the source domains it cited. Grounding is a
   *  server-side tool — it never appears as a function call — so without
   *  this a searched answer and a recalled one are indistinguishable. */
  grounding?: { queries: string[]; sources: string[] };
}

/** Domain of a grounding chunk: Gemini's `web.title` is already the bare
 *  domain (its `uri` is an opaque redirect); fall back to the URI's host. */
function groundingDomain(chunk: any): string | null {
  const title: string | undefined = chunk?.web?.title;
  if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) return title.toLowerCase();
  const uri: string | undefined = chunk?.web?.uri;
  if (uri) {
    try { return new URL(uri).hostname.replace(/^www\./, ''); } catch { /* opaque */ }
  }
  return title || null;
}

// ── Native ADK AgentExecutor Bridge ───────────────────────────────────────
class SyndicateExecutor implements AgentExecutor {
  private config: SyndicateYamlConfig;
  private sessionService: BaseSessionService;
  private memoryService: BaseMemoryService | undefined;

  constructor(
    config: SyndicateYamlConfig,
    sessionService: BaseSessionService,
    memoryService?: BaseMemoryService,
  ) {
    this.config = config;
    this.sessionService = sessionService;
    this.memoryService = memoryService;
  }

  /**
   * Run ONE agent for ONE turn against a named session, draining its event
   * stream. DELEGATE mode calls this once (the orchestrator); PLAN-DISPATCH
   * calls it twice — the classifier, then the route it chose.
   *
   * Errors are RETURNED rather than published, because the two callers want
   * different things from them: a failed specialist is a failed task, but a
   * failed classifier must fall back to the default route and still answer.
   */
  private async runTurn(params: {
    agent: LlmAgent;
    sessionId: string;
    userId: string;
    userParts: Array<{ text: string }>;
    taskId: string;
    contextId: string;
    eventBus: ExecutionEventBus;
    /** Emit an OTEL syndicate span. False for the classifier — it is one cheap call. */
    trace: boolean;
    /** Publish per-tool `[STATUS]` progress. False for the classifier (it has no tools). */
    publishToolStatus: boolean;
    /**
     * Session service for THIS turn, overriding the executor's. The route
     * turn passes a ProjectedSessionService so the agent reads the shared
     * transcript as conversation; the classifier passes a throwaway
     * in-memory one so its JSON never reaches the durable record.
     */
    sessionService?: BaseSessionService;
  }): Promise<TurnResult> {
    const { agent, sessionId, userId, userParts, taskId, contextId, eventBus } = params;

    const runner = new Runner({
      agent,
      appName: A2A_APP_NAME,
      sessionService: params.sessionService ?? this.sessionService,
      ...(this.memoryService ? { memoryService: this.memoryService } : {})
    });

    let stream = runner.runAsync({
      userId,
      sessionId,
      newMessage: { role: 'user', parts: userParts },
      ...(this.config.max_steps !== undefined ? { maxSteps: this.config.max_steps } : {})
    });

    if (params.trace) {
      stream = traceAgentRun(stream, {
        syndicateName: this.config.syndicate_name || 'melchizedek-syndicate',
        bindings: this.config.variables || {},
        input: userParts
      });
    }

    let combinedText = '';
    let lastToolResultText = '';
    const invokedToolNames = new Set<string>();
    let lastTokenTotal = 0;
    let lastThinkingTokens = 0;
    let error: { code: string; message: string } | undefined;
    const groundingQueries = new Set<string>();
    const groundingSources = new Set<string>();

    for await (const event of stream) {
      const evAny = event as any;

      // Native search grounding rides on the model event, not on a tool call.
      const gm = evAny.groundingMetadata;
      if (gm && (gm.webSearchQueries?.length || gm.groundingChunks?.length)) {
        const before = groundingQueries.size + groundingSources.size;
        for (const q of gm.webSearchQueries ?? []) if (typeof q === 'string' && q.trim()) groundingQueries.add(q.trim());
        for (const c of gm.groundingChunks ?? []) { const d = groundingDomain(c); if (d) groundingSources.add(d); }
        if (groundingQueries.size + groundingSources.size > before) {
          console.log(`[A2A] ⌕ Grounding: ${groundingQueries.size} quer${groundingQueries.size === 1 ? 'y' : 'ies'} · ${groundingSources.size} source${groundingSources.size === 1 ? '' : 's'}${groundingSources.size ? ` (${[...groundingSources].slice(0, 8).join(', ')})` : ''}`);
          if (params.publishToolStatus && before === 0) {
            // Same shape as a function-tool line so consumers that parse
            // "Invoking tool:" (nihilistic-penguin RouteTrace) list it.
            publishWorking(eventBus, taskId, contextId, `Invoking tool: web_search`);
          }
        }
      }

      // Capture token metadata whenever the model emits it
      if (evAny.usageMetadata?.totalTokenCount) {
        lastTokenTotal = evAny.usageMetadata.totalTokenCount;
        lastThinkingTokens = evAny.usageMetadata.thoughtsTokenCount ?? 0;
      }

      if ((evAny.errorCode || evAny.errorMessage) && evAny.errorCode !== 'STOP') {
        error = {
          code: evAny.errorCode ?? 'ERROR',
          message: evAny.errorMessage ?? ''
        };
        console.error(`[A2A] Error [${error.code}]: ${error.message}`);
        break;
      }

      // Tool calls — log formatted name + args, publish working status to eventBus
      const calls = getFunctionCalls(event);
      if (calls && calls.length > 0) {
        for (const call of calls) {
          if (call.name === 'transfer_to_agent') {
            const target = (call.args as any)?.agentName ?? 'unknown';
            console.log(`[A2A] → Delegating to: ${target}`);
            if (params.publishToolStatus) {
              publishWorking(eventBus, taskId, contextId, `Delegating to subagent: ${target}`);
            }
          } else {
            const argStr = formatToolArgs(call.args as Record<string, unknown> | undefined);
            if (call.name) invokedToolNames.add(call.name);
            console.log(`[A2A] → Tool: ${call.name}(${argStr})`);
            if (params.publishToolStatus) {
              publishWorking(eventBus, taskId, contextId, `Invoking tool: ${call.name}`);
            }
          }
        }
      }

      // Tool responses — log name and result size (avoids dumping raw JSON/base64 to logs)
      const responses = getFunctionResponses(event);
      if (responses && responses.length > 0) {
        for (const resp of responses) {
          const respAny = resp as any;
          const respName = respAny.name ?? respAny.functionResponse?.name ?? 'unknown';
          const respContent = respAny.response ?? respAny.functionResponse?.response ?? {};
          const resultStr = typeof respContent === 'string' ? respContent : JSON.stringify(respContent);
          if (respName && respName !== 'unknown') invokedToolNames.add(respName);
          console.log(`[A2A] ← Result: ${respName} — ${resultStr.length.toLocaleString()} chars`);
          // Kept as the DELEGATE-mode relay fallback below. Only plain text
          // results qualify — a structured/base64 payload (e.g. image tools)
          // is not a relayable answer.
          const resultText = typeof respContent === 'string'
            ? respContent
            : typeof (respContent as any).result === 'string' ? (respContent as any).result : '';
          if (resultText.trim()) {
            lastToolResultText = resultText.trim();
          }
        }
      }

      // The answer is the LAST turn's text, not every turn's — the same rule
      // AgentTool applied by returning only its final event. It mattered the
      // moment specialists started running directly: a tool-using agent
      // narrates between calls ("Pulling FinTwit-specific NVDA signal…"), and
      // accumulating glued that commentary to the front of its report. A
      // prompt rule against narrating was not enough on grok-4.5, so the rule
      // lives here instead. Thinking traces are suppressed throughout (too
      // verbose for the server log, and never part of the answer).
      //
      // Within ONE event, parts are joined — a single answer legitimately
      // arrives in several parts. `partial` events are streaming chunks of the
      // turn in progress, so they append rather than replace; this deployment
      // does not enable streaming, but getting it wrong would truncate an
      // answer, which is the failure this whole area exists to prevent.
      let eventText = '';
      if (event.content?.parts) {
        for (const part of event.content.parts) {
          const textContent = (part as any).text ?? '';
          const isThought = (part as any).thought === true;
          if (!isThought && textContent) {
            eventText += textContent;
          }
        }
      }
      if (eventText) {
        combinedText = evAny.partial === true ? combinedText + eventText : eventText;
      }
    }

    if (params.publishToolStatus && groundingSources.size) {
      // Published AFTER the loop so it lands once, with the full set. A
      // consumer contract (penguin RouteTrace `_SOURCES_RE`): "Web sources: a, b".
      publishWorking(eventBus, taskId, contextId, `Web sources: ${[...groundingSources].slice(0, 10).join(', ')}`);
    }

    return {
      text: combinedText.trim(),
      lastToolResultText,
      invokedToolNames,
      grounding: (groundingQueries.size || groundingSources.size)
        ? { queries: [...groundingQueries], sources: [...groundingSources] }
        : undefined,
      tokenInfo: lastTokenTotal > 0
        ? ` | ${lastTokenTotal.toLocaleString()} tokens${lastThinkingTokens > 0 ? ` (${lastThinkingTokens.toLocaleString()} thinking)` : ''}`
        : '',
      error
    };
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const message = requestContext.userMessage as any;
    const rawParts = message.content || message.parts || [];
    const userParts = rawParts.map((p: any) => {
      if (typeof p === 'string') return { text: p };
      return { text: p.text || '' };
    });
    const contextId = requestContext.contextId;
    const taskId = requestContext.taskId;
    const queryPreview = userParts.map((p: any) => p.text ?? '').join(' ').replace(/\n/g, ' ').slice(0, 120);
    console.log(`[A2A] ─── Task ${taskId.slice(0, 8)} | ${this.config.syndicate_name}`);
    console.log(`[A2A] Query: "${queryPreview}${queryPreview.length >= 120 ? '...' : ''}"`);

    try {
      // Initialize task on the event bus to allow non-blocking clients to start polling immediately
      eventBus.publish({
        id: taskId,
        kind: 'task',
        contextId,
        status: {
          state: 'submitted',
          timestamp: new Date().toISOString()
        },
        history: []
      } as any);

      const authContext = requestContextStorage.getStore();
      if (!authContext) {
        throw new Error('No authentication context available.');
      }

      // Session & memory isolation: per-credential by API-key hash, and
      // per end-user beneath it when the caller supplies X-User-Id.
      // See deriveUserId() for the silo contract.
      const userId = deriveUserId(authContext);

      if (userParts.length === 0) throw new Error('Message parts are required.');

      // Model resolution: the YAML model id always wins — its prefix names
      // the provider (claude-*, gpt-*, grok-*, ollama/*, else Gemini). The
      // X-Provider header is DEPRECATED and only picks a default model when
      // the YAML omits `model` entirely. lib/models/registry.ts is the
      // single implementation, shared with the CLI path.
      const resolveModelForRequest = (modelName?: string) =>
        resolveModel(modelName, {
          apiKey: authContext.apiKey,
          defaultProvider: authContext.provider,
        });

      const resolveTools = (toolNames: string[] = []): any[] =>
        resolveNamedTools(toolNames, (name) =>
          console.warn(`[A2A] WARNING: Unknown tool '${name}' — skipping.`),
        );

      // Compile ADK Nodes dynamically.
      //
      // compileSubagent builds ONE runnable agent from a subagent entry. In
      // DELEGATE mode compileGraph wraps its result in an AgentTool; in
      // PLAN-DISPATCH the same agent is run directly as the chosen route, so
      // both methods dispatch to identical agents and can never drift.
      const compileSubagent = async (subCfg: SubagentYamlConfig): Promise<LlmAgent> => {
        if (subCfg.yaml_reference) {
          console.log(`[A2A] Loading nested syndicate: ${subCfg.yaml_reference}`);
          const nestedConfig = loadSyndicate(subCfg.yaml_reference);
          return compileGraph(nestedConfig, subCfg.name, subCfg.description);
        }

        const subTools = resolveTools(subCfg.tools);
        if (subCfg.mcp_server_url) {
          console.log(`[A2A] Loading MCP tools: ${subCfg.mcp_server_url}`);
          const mcpTools = await createMcpTools(subCfg.mcp_server_url);
          for (const mcpTool of mcpTools) {
            if (!subTools.some(t => t.name === mcpTool.name)) {
              subTools.push(mcpTool);
            }
          }
        }

        return new LlmAgent({
          name: subCfg.name,
          description: subCfg.description,
          model: resolveModelForRequest(subCfg.model),
          instruction: subCfg.instruction,
          tools: subTools.length > 0 ? subTools : undefined,
          outputSchema: subCfg.outputSchema as any,
          generateContentConfig: {
            ...(subCfg.generateContentConfig as any),
            toolConfig: {
              ...(subCfg.generateContentConfig as any)?.toolConfig,
              includeServerSideToolInvocations: true
            }
          } as any
        });
      };

      const compileGraph = async (configObj: SyndicateYamlConfig, overrideName?: string, overrideDesc?: string): Promise<LlmAgent> => {
        // PLAN-DISPATCH: the orchestrator gets NO subagent tools. ADK refuses
        // to combine outputSchema with AgentTool delegation on one agent (see
        // config/agents/critic.yaml), and the classifier needs the schema —
        // code, not the model, performs the hand-off.
        const compiledTools: any[] = isDispatchSyndicate(configObj)
          ? []
          : await Promise.all((configObj.subagents || []).map(async (subCfg) =>
              new AgentTool({ agent: await compileSubagent(subCfg) })));

        const orchestratorDirectTools = resolveTools(configObj.orchestrator.tools);
        compiledTools.push(...orchestratorDirectTools);

        return new LlmAgent({
          name: overrideName || configObj.orchestrator.name,
          description: overrideDesc || configObj.orchestrator.description,
          model: resolveModelForRequest(configObj.orchestrator.model),
          instruction: configObj.orchestrator.instruction,
          tools: compiledTools.length > 0 ? compiledTools : undefined,
          outputSchema: configObj.orchestrator.outputSchema as any,
          generateContentConfig: {
            ...(configObj.orchestrator.generateContentConfig as any),
            toolConfig: {
              ...(configObj.orchestrator.generateContentConfig as any)?.toolConfig,
              includeServerSideToolInvocations: true
            }
          } as any
        });
      };

      const ensureSession = async (sessionId: string): Promise<boolean> => {
        const existing = await this.sessionService.getSession({
          sessionId,
          appName: A2A_APP_NAME,
          userId
        });
        if (existing) return true;
        await this.sessionService.createSession({
          sessionId,
          appName: A2A_APP_NAME,
          userId
        });
        return false;
      };

      const failTask = (text: string): void => {
        eventBus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'failed',
            message: {
              kind: 'message',
              messageId: crypto.randomUUID(),
              role: 'agent',
              parts: [{ kind: 'text', text }],
              contextId,
              taskId
            },
            timestamp: new Date().toISOString()
          },
          final: true
        } as any);
      };

      const resumed = await ensureSession(contextId);
      console.log(`[A2A] Session: ${resumed ? 'resumed' : 'new'} — context ${contextId.slice(0, 8)}`);

      let finalText = '';
      let tokenInfo = '';
      let routerTokenInfo = '';

      if (isDispatchSyndicate(this.config)) {
        // ══ PLAN ═══════════════════════════════════════════════════════════
        // Deterministic overrides come FIRST: when the message itself decides
        // the route (an x.com link only XScout can open, an explicit demand
        // for a named tool), there is nothing to classify. The classifier LLM
        // call is skipped entirely — cheaper, and immune to a weak classifier
        // out-voting a stated rule (2026-08-15).
        const overrideWarnings: string[] = [];
        const messageText = userParts.map((p: { text?: string }) => p.text ?? '').join('\n');
        let resolution = matchRouteOverride(messageText, this.config, overrideWarnings);
        for (const warning of overrideWarnings) console.warn(`[A2A] ⚠ ${warning}`);

        if (resolution) {
          console.log(`[A2A] ⇄ Route pinned by override: ${resolution.route}`);
        } else {
          // ── The classifier reads the SHARED transcript ──────────────────
          // Its JSON verdicts must never enter the user-facing transcript —
          // the next specialist would read them as conversation — so it does
          // not write to the shared session. It used to get its own durable
          // `<contextId>::route` lane instead, and that lane was the bug: it
          // accumulated the user's messages and the router's own verdicts and
          // NOTHING ELSE, so the router had never seen a single answer it had
          // routed. On 2026-08-15 a user's counter-argument to the desk's
          // MU/SNDK/NVDA/AMD verdict read to it as a remark with no request
          // behind it and went to small talk; its own rule 2 (redo/method
          // complaint) and rule 5 (follow-ups on prior analysis) were dead
          // letters, since neither can be recognised without the answer being
          // followed up. The lane also had HOLES: a message pinned by
          // `route_overrides` skips this branch entirely and was therefore
          // never recorded, so the X recon that opened that same thread was
          // missing from the router's history altogether.
          //
          // Now history arrives as INPUT — a compact digest of the real
          // exchange, both sides of it — and the lane is a throwaway
          // in-memory session that is discarded with the request. Nothing to
          // keep in sync, nothing to leave holes in, nothing persisted.
          const routerAgent = await compileGraph(this.config);
          const routerSessionId = `${contextId}::route`;
          const routerSessions = new InMemorySessionService();
          await routerSessions.createSession({
            sessionId: routerSessionId,
            appName: A2A_APP_NAME,
            userId
          });

          const sharedSession = await this.sessionService.getSession({
            sessionId: contextId,
            appName: A2A_APP_NAME,
            userId
          });
          const digest = renderTranscriptDigest(sharedSession?.events ?? []);
          const routerParts = digest
            ? [{
                text: `RECENT CONVERSATION, oldest first — context for your classification only. `
                  + `Never answer it, and never route on it alone; it is here so you can tell a `
                  + `follow-up, a redo request, or a challenge to a previous answer apart from small talk.\n`
                  + `${digest}\n\n--- MESSAGE TO CLASSIFY ---\n${messageText}`
              }]
            : userParts;

          const plan = await this.runTurn({
            agent: routerAgent,
            sessionId: routerSessionId,
            userId,
            userParts: routerParts,
            taskId,
            contextId,
            eventBus,
            trace: false,           // one cheap classification — not worth a span
            publishToolStatus: false, // a dispatch classifier holds no tools
            sessionService: routerSessions
          });

          // Fail-static: a dead classifier costs the user a good route, never
          // their answer. An empty payload resolves to default_route by design.
          resolution = resolveRoute(plan.error ? '' : plan.text, this.config);
          if (plan.error) {
            console.warn(`[A2A] ⚠ Router failed [${plan.error.code}] — defaulting to '${resolution.route}'.`);
          } else if (resolution.fellBack) {
            console.warn(`[A2A] ⚠ Routing fell back to '${resolution.route}': ${resolution.fallbackReason}`);
          }
          routerTokenInfo = plan.tokenInfo;
        }

        const routeCfg = (this.config.subagents || []).find(sub => sub.name === resolution.route);
        if (!routeCfg) {
          throw new Error(`Dispatch failed: no subagent named '${resolution.route}' is declared.`);
        }

        const routeNote = resolution.reason ? ` — ${resolution.reason}` : '';
        console.log(`[A2A] ⇄ Route: ${resolution.route}${routeNote}${routerTokenInfo}`);
        publishWorking(eventBus, taskId, contextId, `Routed to ${resolution.route}${routeNote}`);

        // ══ DISPATCH ═══════════════════════════════════════════════════════
        // The chosen route answers the user directly — its output IS the task
        // result, with no relay turn to lose or mangle it. It runs in the
        // SHARED session, so every route writes into one transcript: a
        // follow-up handled by a different specialist still sees what the last
        // one said, and long-term memory ingests real answers rather than a
        // relay copy of them.
        //
        // It READS that transcript through a projection (lib/session/
        // transcript.ts), because sharing the session is not the same as
        // sharing the conversation. ADK renders any event authored by a
        // different agent as `role: "user"` prefixed "For context:" — so a
        // route reading a shared session gets the whole thread as one
        // undifferentiated user monologue, with the previous route's private
        // reasoning and raw tool payloads mixed into it. The projection hands
        // it real `role: "model"` turns instead, labelled by the desk that
        // spoke, with thoughts and tool traffic stripped.
        const routeAgent = await compileSubagent(routeCfg);
        const turn = await this.runTurn({
          agent: routeAgent,
          sessionId: contextId,
          userId,
          userParts,
          taskId,
          contextId,
          eventBus,
          trace: true,
          publishToolStatus: true,
          sessionService: new ProjectedSessionService(this.sessionService, routeCfg.name)
        });

        if (turn.error) {
          failTask(`Error: [${turn.error.code}] ${resolution.route} failed to answer. See server logs for details.`);
          return;
        }

        tokenInfo = turn.tokenInfo;
        finalText = turn.text;
        if (!finalText) {
          // Naming the route turns a blank reply into a lead. This is the
          // shape the XScout outage took: the specialist ran and returned
          // nothing because its provider rejected the call upstream.
          console.warn(`[A2A] ⚠ Route '${resolution.route}' produced no output.`);
          finalText = `${resolution.route} returned no output — the server logs carry the upstream error.`;
        }
      } else {
        // ══ DELEGATE (classic) ═════════════════════════════════════════════
        // Subagents are AgentTools; the orchestrator relays the answer it got.
        const orchestrator = await compileGraph(this.config);
        const turn = await this.runTurn({
          agent: orchestrator,
          sessionId: contextId,
          userId,
          userParts,
          taskId,
          contextId,
          eventBus,
          trace: true,
          publishToolStatus: true
        });

        if (turn.error) {
          failTask(`Error: [${turn.error.code}] The agent run failed. See server logs for details.`);
          return;
        }

        tokenInfo = turn.tokenInfo;

        // Failed-relay fallback: an orchestrator (flash-lite especially) can
        // botch the hop that relays a specialist answer, in two observed ways —
        // finishing STOP with zero output tokens, or emitting the bare tool NAME
        // as its text ("FinancialAnalyst", 3 tokens) instead of the answer. Both
        // discard a fully-formed result, so the last tool result is returned
        // deterministically rather than retrying the relay LLM (a retry costs a
        // full round-trip and can fail the same way again).
        //
        // PLAN-DISPATCH does not need any of this — it has no relay turn to
        // fail. This branch is why the two methods exist side by side.
        //
        // Degenerate-text detection is deliberately narrow — an exact match to an
        // invoked tool name after stripping non-alphanumerics — because short
        // real answers are legitimate ("Yes, as of Q2 2026."), so no length or
        // ratio heuristic may be used here.
        const normalize = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
        finalText = turn.text;
        const echoedToolName = finalText.length > 0 && [...turn.invokedToolNames]
          .some(name => normalize(name) === normalize(finalText));

        if ((!finalText || echoedToolName) && turn.lastToolResultText) {
          const reason = echoedToolName
            ? `echoed the tool name ("${finalText}")`
            : 'emitted no text';
          console.warn(`[A2A] ⚠ Orchestrator ${reason} — relaying last tool result verbatim (${turn.lastToolResultText.length.toLocaleString()} chars).`);
          finalText = turn.lastToolResultText;
        }
      }

      if (finalText) {
        console.log(`[A2A] ✓ Task ${taskId.slice(0, 8)} complete — ${finalText.length.toLocaleString()} chars${tokenInfo}`);
        eventBus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'completed',
            message: {
              kind: 'message',
              messageId: crypto.randomUUID(),
              role: 'agent',
              parts: [{ kind: 'text', text: finalText }],
              contextId,
              taskId
            },
            timestamp: new Date().toISOString()
          },
          final: true
        } as any);
      } else {
        console.log(`[A2A] ✓ Task ${taskId.slice(0, 8)} complete — empty output`);
        eventBus.publish({
          kind: 'status-update',
          taskId,
          contextId,
          status: {
            state: 'completed',
            timestamp: new Date().toISOString()
          },
          final: true
        } as any);
      }

      // Long-term memory ingestion: the A2A server is stateless, so there is
      // no "session end" moment like the CLI's exit — ingest after every
      // completed task instead. The memory service dedupes facts per user
      // key, so re-serializing the same conversation next turn is harmless.
      // Runs AFTER the final status publish so it never delays the reply.
      if (this.memoryService) {
        try {
          const endedSession = await this.sessionService.getSession({
            sessionId: contextId,
            appName: A2A_APP_NAME,
            userId
          });
          if (endedSession && endedSession.events.length > 0) {
            // The Supabase service accepts per-consumer extraction rules; the
            // base interface does not declare them, and only that service is
            // ever wired here (startServer constructs it directly).
            await (this.memoryService as SupabaseVectorMemoryService)
              .addSessionToMemory(endedSession, this.config.memory_extraction_rules);
          }
        } catch (memErr: unknown) {
          const msg = memErr instanceof Error ? memErr.message : String(memErr);
          console.error(`[A2A] ⚠ Memory ingestion failed (reply already delivered): ${msg}`);
        }
      }
    } catch (error: any) {
      console.error(`[A2A] Exception on task ${taskId.slice(0, 8)}: ${error.message}`);
      eventBus.publish({
        kind: 'status-update',
        taskId,
        contextId,
        status: {
          state: 'failed',
          message: {
            kind: 'message',
            messageId: crypto.randomUUID(),
            role: 'agent',
            parts: [{ kind: 'text', text: 'Internal Error: the request could not be completed. See server logs for details.' }],
            contextId,
            taskId
          },
          timestamp: new Date().toISOString()
        },
        final: true
      } as any);
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(): Promise<void> {}
}

// ── Bootstrap Routine ──────────────────────────────────────────────────────
export async function startServer(syndicateName: string = 'syndicate.yaml') {
  loadEnv(import.meta.url);
  // Suppress ADK internal INFO/DEBUG logs (raw event JSON, embeddings, binary blobs)
  setLogLevel(LogLevel.WARN);
  const serverBindings = {
    current_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  };

  let config: SyndicateYamlConfig;
  if (syndicateName.startsWith('registry:')) {
    const registryId = syndicateName.replace('registry:', '');
    // Lazy import to prevent circular dependency issues during regular boot
    const { loadSyndicateFromRegistry } = await import('../lib/loadSyndicate.ts');
    config = await loadSyndicateFromRegistry(registryId, { bindings: serverBindings });
  } else {
    config = loadSyndicate(syndicateName, { bindings: serverBindings });
  }
  const agentCard = compileAgentCard(config);

  // Persistence: sessions whenever Supabase credentials exist. The memory
  // service is constructed alongside (it's just a client handle) but is only
  // handed to executors whose syndicate opts in via memory_system:
  // "long-term" — static agent here, dynamic agents per-config below.
  // Embeddings and fact extraction use the SERVER's Gemini key (memory is
  // operator infrastructure, like tools); the caller's BYOK key only funds
  // inference.
  const wantsLongTermMemory = config.memory_system === 'long-term';
  let sessionService: BaseSessionService = new InMemorySessionService();
  let memoryService: BaseMemoryService | undefined;
  if (hasSupabaseCredentials()) {
    const services = await createSupabaseServices({
      apiKey: process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || '',
      withMemory: true
    });
    sessionService = services.sessionService;
    memoryService = services.memoryService;
    if (wantsLongTermMemory) {
      console.log(`[A2A] Long-term memory enabled for "${config.syndicate_name}" (per-user silos via X-User-Id).`);
    }

    // Defense-in-depth check: warn operators when db/hardening.sql has not
    // been applied. Without it, the anon/authenticated Supabase API paths
    // can read adk_sessions and adk_memory_facts directly — the application
    // silo (user_key) does nothing against that route. Escalation mirrors
    // the A2A_SERVER_SECRET pattern: fatal for public deployments unless
    // explicitly overridden.
    const rls = await services.checkRlsHardening();
    if (rls.applied) {
      console.log(`[A2A] ✓ DB hardening verified — ${rls.detail}.`);
    } else {
      const allowUnhardened = process.env.ALLOW_UNHARDENED_DB === 'true';
      if (process.env.PUBLIC_URL && !allowUnhardened) {
        console.error('[A2A] ✗ FATAL: PUBLIC_URL is set but Supabase hardening is missing');
        console.error(`[A2A]   (${rls.detail}).`);
        console.error('[A2A]   User transcripts and memory facts are exposed to the anon API key.');
        console.error('[A2A]   Run db/hardening.sql in the Supabase SQL Editor, or set');
        console.error('[A2A]   ALLOW_UNHARDENED_DB=true to accept the risk explicitly.');
        process.exit(1);
      }
      console.log(`[A2A] ⚠ WARNING: Supabase hardening not applied — ${rls.detail}.`);
      console.log('[A2A]   Run db/hardening.sql before serving real user data. Details:');
      console.log('[A2A]   lib/memory/README.md → "Hardening".');
    }
  } else if (wantsLongTermMemory) {
    console.log('[A2A] ⚠ WARNING: syndicate requests long-term memory but Supabase credentials are missing — memory disabled.');
  }

  const app = express();
  app.set('trust proxy', 1); // Trust Heroku proxy for accurate IP rate limiting

  // Security: Server-Level Authentication (Before body parsing)
  const serverSecret = process.env.A2A_SERVER_SECRET;
  if (!serverSecret) {
    // Running without a shared secret leaves every endpoint open (the BYOK
    // X-API-Key check only verifies presence, not validity). Tolerate this for
    // local dev, but refuse to boot a publicly-addressable deployment.
    if (process.env.PUBLIC_URL) {
      console.error('[A2A] ✗ FATAL: PUBLIC_URL is set but A2A_SERVER_SECRET is missing. Refusing to start an unauthenticated public server.');
      process.exit(1);
    }
    console.log('[A2A] ⚠ WARNING: A2A_SERVER_SECRET is not configured. Server-level authentication is disabled (local dev only).');
  } else {
    const expected = Buffer.from(serverSecret);
    app.use((req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization Bearer token' });
        return;
      }
      const token = Buffer.from(authHeader.substring(7));
      // Constant-time comparison to avoid leaking the secret via response timing.
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
        res.status(401).json({ error: 'Unauthorized: Invalid Authorization Bearer token' });
        return;
      }
      next();
    });
  }

  app.use(express.json());


  // Security: BYOK Middleware
  // NOTE ON SCOPE: the X-API-Key only funds LLM *inference* (Gemini/Claude).
  // Tool calls (e.g. generate_image, google_search) use the server's own
  // keys from the environment, so they bill the operator, not the caller. This
  // check verifies the header is present, not that the key is valid — validity
  // is enforced upstream by the provider. The bearer token above is the real
  // gate; keep it set in any shared/public deployment.
  app.use((req, res, next) => {
    const apiKey = req.headers['x-api-key'] as string;
    const provider = req.headers['x-provider'] as string || 'google';
    const rawUserId = req.headers['x-user-id'] as string | undefined;

    if (!apiKey) {
      res.status(401).json({ error: 'Unauthorized: Missing X-API-Key header' });
      return;
    }

    // X-User-Id (optional): the caller's own identifier for the END USER
    // behind this request (e.g. a site's authenticated account id). It
    // silos sessions AND long-term memory per user beneath the caller's
    // API-key hash. Callers are responsible for authenticating their users
    // BEFORE putting an id in this header — the server trusts it within
    // the caller's own silo and it can never cross into another caller's.
    let siteUserId: string | undefined;
    if (rawUserId !== undefined && rawUserId !== '') {
      if (!SITE_USER_ID_PATTERN.test(rawUserId)) {
        res.status(400).json({ error: 'Invalid X-User-Id: must match [A-Za-z0-9._-]{1,64}' });
        return;
      }
      siteUserId = rawUserId;
    }

    requestContextStorage.run({ apiKey, provider, siteUserId }, () => {
      next();
    });
  });

  // Security: Rate Limiting
  // Applied globally (not just to /a2a) so the per-agent dynamic routes
  // (/:agentId/a2a/...) can't be used to bypass the cap. GET requests are
  // exempted because task-status polling issues many GETs per task and is
  // cheap; the limit targets the expensive POST task submissions.
  // NOTE: the bearer-auth middleware above runs BEFORE this limiter, so only
  // AUTHENTICATED callers ever reach it — its role is runaway/cost protection
  // (a buggy client loop burning Gemini quota), not anonymous-abuse defense.
  // Sized for the nihilistic-penguin daily advisory pipeline (~34 task
  // submissions in one burst: 30 council + news + macro + architect + critic)
  // plus concurrent interactive Discord use; the old 20/hour cap forced that
  // pipeline into multi-window backoff crawls. GETs (task polling) stay exempt.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 60, // 60 task submissions per 15 min per IP (~240/h runaway ceiling)
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === 'GET',
    message: { error: 'Too many requests, please try again later.' }
  });
  app.use(limiter);

  // ── Right-to-erasure: DELETE /memory ─────────────────────────────────────
  // Permanently removes every long-term fact in the CALLING silo — the
  // API-key hash plus X-User-Id, exactly as deriveUserId computes it for
  // storage. A site deletes one of its users by passing that user's id in
  // X-User-Id; it cannot name an arbitrary silo, so it can only erase what
  // it could write. Sessions (adk_sessions) are a separate store — see
  // lib/memory/README.md.
  app.delete('/memory', async (_req, res) => {
    if (!memoryService) {
      res.status(404).json({ error: 'Long-term memory is not enabled on this server.' });
      return;
    }
    const ctx = requestContextStorage.getStore();
    if (!ctx) {
      res.status(401).json({ error: 'No authentication context.' });
      return;
    }
    const userKey = `${A2A_APP_NAME}/${deriveUserId(ctx)}`;
    try {
      const deleted = await (memoryService as SupabaseVectorMemoryService).deleteUserMemory(userKey);
      console.log(`[A2A] Memory erasure: ${deleted} fact(s) removed for silo ${userKey}`);
      res.json({ deleted });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[A2A] Memory erasure failed: ${msg}`);
      res.status(500).json({ error: 'Memory deletion failed. See server logs.' });
    }
  });

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    new SyndicateExecutor(config, sessionService, wantsLongTermMemory ? memoryService : undefined)
  );

  // Setup Static/Default Routing Interfaces (Backward Compatibility)
  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/a2a/jsonrpc', jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));
  app.use('/a2a/rest', restHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  // Dynamic Multi-Agent Routing Cache
  const handlerCache = new Map<string, {
    agentCard: any,
    jsonRpc: any,
    rest: any
  }>();

  // Security: agent IDs address a syndicate config (file, or "registry:<id>").
  // Restrict to a safe charset so a crafted path segment cannot drive path
  // traversal through loadSyndicate() or the filesystem fallbacks below.
  function isValidAgentId(agentId: string): boolean {
    return /^[A-Za-z0-9_.:-]+$/.test(agentId) && !agentId.includes('..');
  }

  async function getOrCreateHandlers(agentId: string) {
    if (!isValidAgentId(agentId)) {
      throw new Error(`Invalid agent id: '${agentId}'`);
    }
    let cached = handlerCache.get(agentId);
    if (cached) return cached;

    let targetConfig: SyndicateYamlConfig;
    // Fresh per-load bindings: the static routes get these via startServer's
    // serverBindings; without them here, dynamic agents would interpolate
    // {{current_date}} from stale YAML defaults (or leave it unresolved).
    const routeBindings = {
      current_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    };
    // Where the config came from is load-bearing operational information: a
    // bare agent id prefers the REGISTRY and only falls back to the repo file
    // when that lookup fails, so an id with a registry row ignores repo edits
    // until `scripts/deploy_agent.ts` re-publishes it. On 2026-08-15 two
    // rounds of routing fixes were pushed, deployed and restarted while
    // production kept serving a registry copy from a week earlier, and
    // nothing in the logs said so. Now it does.
    let configSource = '';
    try {
      if (agentId.startsWith('registry:')) {
        const registryId = agentId.replace('registry:', '');
        const { loadSyndicateFromRegistry } = await import('../lib/loadSyndicate.ts');
        targetConfig = await loadSyndicateFromRegistry(registryId, { bindings: routeBindings });
        configSource = `registry:${registryId}`;
      } else {
        try {
          const { loadSyndicateFromRegistry } = await import('../lib/loadSyndicate.ts');
          targetConfig = await loadSyndicateFromRegistry(agentId, { bindings: routeBindings });
          configSource = `registry:${agentId} (repo file NOT served — deploy_agent.ts publishes edits)`;
        } catch {
          if (agentId.endsWith('.yaml')) {
            targetConfig = loadSyndicate(agentId, { bindings: routeBindings });
            configSource = `file:${agentId}`;
          } else {
            try {
              targetConfig = loadSyndicate(`config/agents/${agentId}.yaml`, { bindings: routeBindings });
              configSource = `file:config/agents/${agentId}.yaml`;
            } catch {
              targetConfig = loadSyndicate(`${agentId}.yaml`, { bindings: routeBindings });
              configSource = `file:${agentId}.yaml`;
            }
          }
        }
      }
    } catch (error: any) {
      throw new Error(`Failed to load syndicate config for '${agentId}': ${error.message}`);
    }
    console.log(`[A2A] ⚙ Loaded '${agentId}' from ${configSource}`);

    const card = compileAgentCard(targetConfig);
    const handler = new DefaultRequestHandler(
      card,
      new InMemoryTaskStore(),
      new SyndicateExecutor(
        targetConfig,
        sessionService,
        targetConfig.memory_system === 'long-term' ? memoryService : undefined
      )
    );

    cached = {
      agentCard: agentCardHandler({ agentCardProvider: handler }),
      jsonRpc: jsonRpcHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication }),
      rest: restHandler({ requestHandler: handler, userBuilder: UserBuilder.noAuthentication })
    };

    handlerCache.set(agentId, cached);
    return cached;
  }

  // Dynamic Route Registration (Exposes /:agentId/a2a/...)
  app.use('/:agentId/.well-known/agent-card.json', async (req, res, next) => {
    console.log(`[A2A Server] GET /${req.params.agentId}/.well-known/agent-card.json`);
    try {
      const handlers = await getOrCreateHandlers(req.params.agentId);
      handlers.agentCard(req, res, next);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.use('/:agentId/agent-card.json', async (req, res, next) => {
    console.log(`[A2A Server] GET /${req.params.agentId}/agent-card.json`);
    try {
      const handlers = await getOrCreateHandlers(req.params.agentId);
      handlers.agentCard(req, res, next);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.use('/:agentId/a2a/jsonrpc', async (req, res, next) => {
    console.log(`[A2A Server] POST /${req.params.agentId}/a2a/jsonrpc`);
    try {
      const handlers = await getOrCreateHandlers(req.params.agentId);
      handlers.jsonRpc(req, res, next);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.use('/:agentId/a2a/rest', async (req, res, next) => {
    // Only log task submissions (POST), not the repeated GET polling requests
    if (req.method !== 'GET') {
      console.log(`[A2A] ${req.method} /${req.params.agentId}/a2a/rest`);
    }
    try {
      const handlers = await getOrCreateHandlers(req.params.agentId);
      handlers.rest(req, res, next);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => {
    console.log(`[A2A] Exposer server boot complete on port ${PORT}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Running as a script
  const syndicateFile = process.argv[2] || 'syndicate.yaml';
  startServer(syndicateFile).catch(console.error);
}
