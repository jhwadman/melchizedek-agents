/**
 * lib/a2a/executor.ts — the A2A AgentExecutor: translates one A2A task into
 * one `runSyndicateTurn` (lib/runtime/syndicateTurn.ts) and the turn's
 * progress and result back into A2A task events.
 *
 * It owns only what is specific to the protocol: task lifecycle events,
 * `[STATUS]` progress messages, the failure text a client renders, task
 * cancellation, the per-server concurrency cap, and memory ingestion after
 * the reply. Every turn semantic — dispatch, delegation, relay fallback,
 * guards, the step cap — is the runtime's.
 */

import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Role, TaskState } from '@a2a-js/sdk';
import type { Message, Part } from '@a2a-js/sdk';
import { AgentEvent } from '@a2a-js/sdk/server';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { BaseMemoryService, BaseSessionService } from '@google/adk';

import type { CompileOptions } from '../compile.ts';
import { loadSyndicate } from '../loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import { configDigest } from '../observability/lineage.ts';
import { ingestTurnMemory, runSyndicateTurn } from '../runtime/syndicateTurn.ts';
import type { MessagePart, SyndicateTurnResult, TurnUsage } from '../runtime/syndicateTurn.ts';
import type { TaskRecord } from '../observability/metrics.ts';
import type { Policy } from './policy.ts';

/** Per-request caller context, set by the server's identity middleware. */
export interface A2AContext {
  /** The caller's provider key in BYOK mode (or from resolveRequest); '' otherwise. */
  apiKey: string;
  provider: string;
  /**
   * The opaque key this caller's sessions and memory are stored under
   * (ADR 0017): supplied by `resolveRequest`, or derived by the key mode —
   * the key-hash silo in BYOK mode, X-User-Id (else 'default') in server mode.
   */
  scopeKey: string;
  /** Optional end-user identifier supplied via X-User-Id (validated). */
  siteUserId?: string;
  /** Telemetry-only surface identity (X-Surface-*). Never reaches the
   *  session key, the memory silo, or any prompt. */
  surface?: SurfaceContext;
  /** Which authenticated caller this is (a caller name, 'jwt', …), for logs. */
  caller?: string;
  /** The scope owns the scopes nested beneath it (`<scope>/<user>`): an
   *  erasure with no end user then removes those too. */
  ownsNested?: boolean;
  /** A backend the operator issued a credential to (a caller token, the
   *  server secret), as opposed to an end user (a JWT, a gateway header).
   *  Operator-only adopter routes check it. */
  operator?: boolean;
}

export interface SurfaceContext {
  name: string;
  guild?: string;
  channel?: string;
  /** A pseudonym the caller derives (a salted hash), never a platform id. */
  user?: string;
}

export const requestContextStorage = new AsyncLocalStorage<A2AContext>();

/** The app name every A2A session and memory silo is stored under. */
export const A2A_APP_NAME = 'melchizedek-a2a';

/**
 * Memory/session silo derivation. Base silo: a hash of the caller's API key
 * (one bucket per credential). With X-User-Id, the end-user is siloed
 * BENEATH the key hash, so no caller can reach another credential's buckets.
 */
export function deriveUserId(ctx: Pick<A2AContext, 'apiKey' | 'siteUserId'>): string {
  const keyHash = createHash('sha256').update(ctx.apiKey).digest('hex').slice(0, 16);
  return ctx.siteUserId ? `a2a-${keyHash}/${ctx.siteUserId}` : `a2a-${keyHash}`;
}

/** Root-span attributes for the caller's surface (absent headers add none). */
export function surfaceAttributes(ctx: A2AContext | undefined): Record<string, string> {
  const s = ctx?.surface;
  if (!s) return {};
  const attrs: Record<string, string> = { 'surface.name': s.name };
  if (s.guild) attrs['surface.guild'] = s.guild;
  if (s.channel) attrs['surface.channel'] = s.channel;
  if (s.user) attrs['surface.user'] = s.user;
  return attrs;
}

/** One human-readable line naming WHY a turn failed, for the failed task's
 *  status message — the text a client renders verbatim. Provider errors
 *  sometimes arrive as a raw JSON blob (Gemini ApiError), so the inner
 *  message is dug out first. */
export function describeTurnError(error: { code: string; message: string }): string {
  let msg = (error.message ?? '').trim();
  if (msg.startsWith('{')) {
    try {
      const parsed = JSON.parse(msg);
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === 'string' && inner.trim()) msg = inner.trim();
    } catch { /* not JSON — use as-is */ }
  }
  if (!msg) return 'see server logs for details.';
  return msg.length > 300 ? `${msg.slice(0, 297)}...` : msg;
}

/** The failed task's message for a turn result. */
export function describeFailedTurn(result: SyndicateTurnResult): string {
  const error = result.error ?? { code: 'ERROR', message: '' };
  if (result.stopReason) return `Error: [${error.code}] ${error.message}`;
  if (result.failedStage === 'dispatch' && result.route) {
    return `Error: [${error.code}] ${result.route.route} failed to answer — ${describeTurnError(error)}`;
  }
  return `Error: [${error.code}] The agent run failed — ${describeTurnError(error)}`;
}

/**
 * A2A message parts → model parts. Text passes through; a `data` part
 * becomes its JSON as text (callers inject structured payloads this way).
 * File parts (`url` or `raw` content) are refused with a clear error rather
 * than silently blanked: a file URL fetched server-side is an SSRF surface,
 * and inline bytes need a size policy this server does not yet have.
 *
 * Accepts A2A 1.0 parts (`content.$case`) and, for callers that hand in
 * plain objects, the 0.3 shapes (`kind: 'text' | 'data' | 'file'`).
 */
export function a2aPartsToMessage(rawParts: unknown[]): { parts: MessagePart[]; refused?: string } {
  const parts: MessagePart[] = [];
  const refusal = 'File parts are not supported by this server; send text or data parts.';
  for (const raw of rawParts) {
    if (typeof raw === 'string') {
      parts.push({ text: raw });
      continue;
    }
    const p = (raw ?? {}) as Record<string, any>;
    const content = p.content as { $case?: string; value?: unknown } | undefined;
    if (content?.$case) {
      if (content.$case === 'text' && typeof content.value === 'string' && content.value.length > 0) parts.push({ text: content.value });
      else if (content.$case === 'data') parts.push({ text: JSON.stringify(content.value) });
      else if (content.$case === 'url' || content.$case === 'raw') return { parts, refused: refusal };
      continue;
    }
    const kind = p.kind ?? (p.text !== undefined ? 'text' : p.data !== undefined ? 'data' : p.file !== undefined ? 'file' : undefined);
    if (kind === 'text') {
      if (typeof p.text === 'string' && p.text.length > 0) parts.push({ text: p.text });
    } else if (kind === 'data') {
      parts.push({ text: JSON.stringify(p.data) });
    } else if (kind === 'file') {
      return { parts, refused: refusal };
    }
  }
  return { parts };
}

export interface ExecutorOptions {
  config: SyndicateYamlConfig;
  sessionService: BaseSessionService;
  memoryService?: BaseMemoryService;
  /** Builds the per-request model resolver from the caller's context (BYOK). */
  compileFor: (ctx: A2AContext) => CompileOptions;
  /** Wall-clock budget per task in ms; 0 or undefined = none. */
  taskTimeoutMs?: number;
  /** Shared across every executor on the server. */
  limiter: TaskLimiter;
  /** The agent id this executor serves ('' for the default syndicate). */
  agentId?: string;
  /** Admission and spend accounting (budgets), when configured. */
  policy?: Policy;
  /** One record per task, however it ended: the task log and metrics. */
  onTaskEnd?: (record: TaskRecord) => void;
  log: (message: string) => void;
  warn: (message: string) => void;
}

const NO_USAGE: TurnUsage = { llmCalls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

/** Concurrency cap and in-flight registry shared by all executors. */
export class TaskLimiter {
  readonly max: number;
  private readonly running = new Map<string, AbortController>();
  private draining = false;
  private idleWaiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = max > 0 ? max : Infinity;
  }

  get inFlight(): number {
    return this.running.size;
  }

  /** Reserve a slot. Returns undefined when saturated or shutting down. */
  acquire(taskId: string): AbortController | undefined {
    if (this.draining || this.running.size >= this.max) return undefined;
    const controller = new AbortController();
    this.running.set(taskId, controller);
    return controller;
  }

  release(taskId: string): void {
    this.running.delete(taskId);
    if (this.running.size === 0) for (const w of this.idleWaiters.splice(0)) w();
  }

  cancel(taskId: string): boolean {
    const c = this.running.get(taskId);
    if (!c) return false;
    c.abort();
    return true;
  }

  /** Stop admitting tasks; resolve when all running ones finish or `graceMs` passes,
   *  then cancel whatever is left. */
  async drain(graceMs: number): Promise<number> {
    this.draining = true;
    if (this.running.size > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, graceMs);
        this.idleWaiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const left = this.running.size;
    for (const c of this.running.values()) c.abort();
    return left;
  }

  get isDraining(): boolean {
    return this.draining;
  }
}

function textPart(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' };
}

function statusMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

type FinalState = 'completed' | 'failed' | 'canceled' | 'rejected';
const FINAL_STATE: Record<FinalState, TaskState> = {
  completed: TaskState.TASK_STATE_COMPLETED,
  failed: TaskState.TASK_STATE_FAILED,
  canceled: TaskState.TASK_STATE_CANCELED,
  rejected: TaskState.TASK_STATE_REJECTED,
};

// `[STATUS]` is a consumer contract, not decoration: A2A clients scan task
// history for messages carrying this prefix and surface them as live
// progress. Keep these lines short and human-readable.
function publishWorking(eventBus: ExecutionEventBus, taskId: string, contextId: string, text: string): void {
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_WORKING,
        message: statusMessage(taskId, contextId, `[STATUS] ${text}`),
        timestamp: new Date().toISOString(),
      },
      metadata: undefined,
    }),
  );
}

function publishFinal(eventBus: ExecutionEventBus, taskId: string, contextId: string, state: FinalState, text?: string): void {
  eventBus.publish(
    AgentEvent.statusUpdate({
      taskId,
      contextId,
      status: {
        state: FINAL_STATE[state],
        message: text ? statusMessage(taskId, contextId, text) : undefined,
        timestamp: new Date().toISOString(),
      },
      metadata: undefined,
    }),
  );
}

export class SyndicateExecutor implements AgentExecutor {
  private readonly opts: ExecutorOptions;
  private configHash: string | undefined;

  constructor(opts: ExecutorOptions) {
    this.opts = opts;
  }

  /** Provenance stamp for every turn this executor serves (lineage.ts). */
  configHashFor(): string {
    if (!this.configHash) {
      try {
        this.configHash = configDigest(this.opts.config, (ref) => loadSyndicate(ref));
      } catch {
        this.configHash = 'unhashable';
      }
    }
    return this.configHash;
  }

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { config, log, warn } = this.opts;
    const message = requestContext.userMessage as any;
    const contextId = requestContext.contextId;
    const taskId = requestContext.taskId;
    const short = taskId.slice(0, 8);
    let slot: AbortController | undefined;
    const started = Date.now();
    const agentId = this.opts.agentId ?? '';
    // Reports the task once: to the task log and metrics, and its spend to
    // the policy. Never throws into the task.
    let reported = false;
    const report = async (
      ctx: A2AContext | undefined,
      status: TaskRecord['status'],
      reason: string | undefined,
      usage: TurnUsage = NO_USAGE,
    ): Promise<void> => {
      if (reported) return;
      reported = true;
      const scopeKey = ctx?.scopeKey ?? '';
      if (ctx && this.opts.policy?.record && status !== 'rejected') {
        try {
          await this.opts.policy.record({ caller: ctx.caller, scopeKey, agentId }, usage);
        } catch (err: unknown) {
          warn(`Usage not recorded for task ${short}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        this.opts.onTaskEnd?.({
          agentId,
          syndicate: config.syndicate_name,
          caller: ctx?.caller,
          scopeHash: scopeKey ? createHash('sha256').update(scopeKey).digest('hex').slice(0, 12) : '',
          status,
          reason,
          durationMs: Date.now() - started,
          usage,
        });
      } catch {
        /* a broken log sink must not fail the task */
      }
    };
    let ctxForReport: A2AContext | undefined;

    try {
      // The first event must be the task itself (A2A 1.0 enforces it).
      eventBus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [],
          history: requestContext.userMessage ? [requestContext.userMessage] : [],
          metadata: undefined,
        }),
      );

      const ctx = requestContextStorage.getStore();
      if (!ctx) throw new Error('No authentication context available.');
      ctxForReport = ctx;

      const { parts, refused } = a2aPartsToMessage(message?.parts ?? message?.content ?? []);
      if (refused) {
        publishFinal(eventBus, taskId, contextId, 'rejected', refused);
        await report(ctx, 'rejected', 'input');
        return;
      }
      if (parts.length === 0) {
        publishFinal(eventBus, taskId, contextId, 'rejected', 'The message has no text.');
        await report(ctx, 'rejected', 'input');
        return;
      }

      // Policy (budgets) before a slot is taken: a refused caller never
      // holds capacity. A policy that throws refuses — fail closed.
      if (this.opts.policy?.admit) {
        let decision;
        try {
          decision = await this.opts.policy.admit({ caller: ctx.caller, scopeKey: ctx.scopeKey, agentId });
        } catch (err: unknown) {
          warn(`Policy check failed for task ${short}: ${err instanceof Error ? err.message : String(err)}`);
          decision = { ok: false as const, reason: 'The server could not check its usage limits; retry shortly.' };
        }
        if (!decision.ok) {
          warn(`Task ${short} rejected by policy — ${decision.reason}`);
          publishFinal(eventBus, taskId, contextId, 'rejected', decision.reason);
          await report(ctx, 'rejected', 'policy');
          return;
        }
      }

      slot = this.opts.limiter.acquire(taskId);
      if (!slot) {
        const why = this.opts.limiter.isDraining
          ? 'The server is shutting down; retry shortly.'
          : `The server is at its limit of ${this.opts.limiter.max} concurrent tasks; retry shortly.`;
        warn(`Task ${short} rejected — ${why}`);
        publishFinal(eventBus, taskId, contextId, 'rejected', why);
        await report(ctx, 'rejected', 'capacity');
        return;
      }

      log(`─── Task ${short} | ${config.syndicate_name}`);
      const userId = ctx.scopeKey;
      // Stored under the syndicate's memory namespace when it declares one
      // (ADR 0020), else the name every syndicate shared before.
      const appName = config.memory_namespace || A2A_APP_NAME;

      const result = await runSyndicateTurn({
        config,
        parts,
        appName,
        userId,
        sessionId: contextId,
        sessionService: this.opts.sessionService,
        memoryService: this.opts.memoryService,
        compile: this.opts.compileFor(ctx),
        signal: slot.signal,
        deadlineMs: this.opts.taskTimeoutMs,
        trace: {
          taskId,
          configHash: this.configHashFor(),
          attributes: surfaceAttributes(ctx),
        },
        events: {
          onProgress: (text) => publishWorking(eventBus, taskId, contextId, text),
          log,
          warn,
        },
      });
      log(`Session: ${result.resumedSession ? 'resumed' : 'new'} — context ${contextId.slice(0, 8)}`);

      const u = result.usage;
      const spent = `${u.llmCalls} model call(s), ${(u.inputTokens + u.outputTokens + u.thinkingTokens).toLocaleString('en-US')} tokens`;
      if (result.status === 'canceled') {
        log(`✗ Task ${short} canceled after ${spent}`);
        publishFinal(eventBus, taskId, contextId, 'canceled', 'The task was canceled.');
        await report(ctx, 'canceled', result.stopReason, u);
        return;
      }
      if (result.status === 'failed') {
        warn(`✗ Task ${short} failed [${result.error?.code}] after ${spent}`);
        publishFinal(eventBus, taskId, contextId, 'failed', describeFailedTurn(result));
        await report(ctx, 'failed', result.error?.code, u);
        return;
      }

      log(`✓ Task ${short} complete — ${result.text.length.toLocaleString()} chars, ${spent}`);
      publishFinal(eventBus, taskId, contextId, 'completed', result.text || undefined);
      await report(ctx, 'completed', undefined, u);

      // Long-term memory: there is no "session end" on a server, so ingest
      // after every completed task. Runs AFTER the final publish, so it never
      // delays the reply, and a failure here never fails the task.
      if (this.opts.memoryService) {
        try {
          await ingestTurnMemory({
            memoryService: this.opts.memoryService,
            sessionService: this.opts.sessionService,
            appName,
            userId,
            sessionId: contextId,
            extractionRules: config.memory_extraction_rules,
          });
        } catch (memErr: unknown) {
          warn(`Memory ingestion failed (reply already delivered): ${memErr instanceof Error ? memErr.message : String(memErr)}`);
        }
      }
    } catch (error: any) {
      warn(`Exception on task ${short}: ${error?.message ?? String(error)}`);
      publishFinal(
        eventBus,
        taskId,
        contextId,
        'failed',
        'Internal Error: the request could not be completed. See server logs for details.',
      );
      await report(ctxForReport, 'failed', 'INTERNAL');
    } finally {
      if (slot) this.opts.limiter.release(taskId);
      eventBus.finished();
    }
  }

  /** Aborts the task's run; `execute` then publishes the `canceled` status. */
  async cancelTask(taskId: string): Promise<void> {
    if (this.opts.limiter.cancel(taskId)) this.opts.log(`Cancel requested for task ${taskId.slice(0, 8)}`);
  }
}
