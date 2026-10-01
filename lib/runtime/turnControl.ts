/**
 * lib/runtime/turnControl.ts — the controls one syndicate turn runs under:
 * a cancellation signal and a budget of model calls, shared by every agent
 * the turn reaches.
 *
 * WHY an AsyncLocalStorage and not a Runner parameter:
 *   ADK's own ceiling (`runConfig.maxLlmCalls`, default 500) is counted per
 *   Runner, and every AgentTool builds a NEW Runner for its subagent without
 *   forwarding the run config — so in DELEGATE mode each subagent call starts
 *   with a fresh 500, and the real bound on a turn is multiplicative. Before
 *   this module the YAML's `max_steps` was passed as `maxSteps`, a parameter
 *   ADK does not have, so it bounded nothing at all.
 *
 *   Every model call in this framework, on every provider, goes through
 *   `traceLlmGeneration` (lib/observability/tracer.ts). That wrapper charges
 *   the budget here, so one counter sees the orchestrator, every subagent,
 *   and every nested syndicate in the turn. The context is carried by
 *   AsyncLocalStorage, which follows the calls ADK makes on our behalf —
 *   including the subagent Runners — without any of them knowing about it.
 *
 *   The same context carries the turn's AbortSignal, so adapters can hand it
 *   to their provider SDK and a cancel or a deadline stops the HTTP call in
 *   flight, not just the loop around it.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Why a turn was stopped before it finished on its own. */
export type TurnStopReason = 'canceled' | 'deadline' | 'step_limit';

export interface TurnControl {
  /** Aborted when the turn must stop: cancel, deadline, or step limit. */
  readonly signal: AbortSignal;
  /** Model calls made so far in this turn, across every agent. */
  llmCalls: number;
  /** Ceiling on model calls for the whole turn; undefined = no ceiling. */
  readonly maxLlmCalls?: number;
  /** Set once, by whichever control stopped the turn first. */
  stopReason?: TurnStopReason;
  /** Stop the turn. The first reason wins. */
  stop(reason: TurnStopReason): void;
}

const storage = new AsyncLocalStorage<TurnControl>();

export interface TurnControlOptions {
  maxLlmCalls?: number;
  /** Wall-clock budget for the whole turn, in milliseconds. */
  deadlineMs?: number;
  /** An outer signal (a cancel request); aborting it cancels the turn. */
  signal?: AbortSignal;
}

/**
 * A control for one turn. Call `dispose()` when the turn ends so the
 * deadline timer and the outer-signal listener are released.
 */
export function createTurnControl(opts: TurnControlOptions = {}): TurnControl & { dispose(): void } {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const control: TurnControl & { dispose(): void } = {
    signal: controller.signal,
    llmCalls: 0,
    maxLlmCalls: opts.maxLlmCalls && opts.maxLlmCalls > 0 ? opts.maxLlmCalls : undefined,
    stopReason: undefined,
    stop(reason) {
      if (control.stopReason) return;
      control.stopReason = reason;
      controller.abort(new Error(stopMessage(reason, control)));
    },
    dispose() {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onOuterAbort);
    },
  };
  const onOuterAbort = () => control.stop('canceled');
  if (opts.signal) {
    if (opts.signal.aborted) control.stop('canceled');
    else opts.signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  if (opts.deadlineMs && opts.deadlineMs > 0) {
    timer = setTimeout(() => control.stop('deadline'), opts.deadlineMs);
  }
  return control;
}

/** Human-readable reason, used for the failed task's message. */
export function stopMessage(reason: TurnStopReason, control?: Pick<TurnControl, 'maxLlmCalls'>): string {
  switch (reason) {
    case 'canceled':
      return 'The task was canceled.';
    case 'deadline':
      return 'The turn exceeded its time limit and was stopped.';
    case 'step_limit':
      return `The turn reached its limit of ${control?.maxLlmCalls ?? '?'} model calls (max_steps) and was stopped.`;
  }
}

/** Run `fn` with `control` as the current turn's control. */
export function runWithTurnControl<T>(control: TurnControl, fn: () => T): T {
  return storage.run(control, fn);
}

/** The current turn's control, if this code is running inside a turn. */
export function currentTurnControl(): TurnControl | undefined {
  return storage.getStore();
}

/** The current turn's abort signal, for adapters to pass to provider SDKs. */
export function currentTurnSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/**
 * Charge one model call against the current turn. Returns a refusal (and
 * stops the turn) when the call would exceed the budget, or when the turn
 * has already been stopped. Outside a turn this always allows the call.
 */
export function chargeLlmCall(): { ok: true } | { ok: false; code: string; message: string } {
  const control = storage.getStore();
  if (!control) return { ok: true };
  if (control.stopReason) {
    return { ok: false, code: stopCode(control.stopReason), message: stopMessage(control.stopReason, control) };
  }
  if (control.maxLlmCalls !== undefined && control.llmCalls >= control.maxLlmCalls) {
    control.stop('step_limit');
    return { ok: false, code: 'STEP_LIMIT', message: stopMessage('step_limit', control) };
  }
  control.llmCalls += 1;
  return { ok: true };
}

export function stopCode(reason: TurnStopReason): string {
  return reason === 'step_limit' ? 'STEP_LIMIT' : reason === 'deadline' ? 'DEADLINE_EXCEEDED' : 'CANCELED';
}

/**
 * Per-request options for a provider SDK call (Anthropic, OpenAI): carries
 * the turn's abort signal so a cancel or deadline aborts the HTTP request
 * in flight. Empty outside a turn.
 */
export function providerRequestOptions(): { signal?: AbortSignal } {
  const signal = currentTurnSignal();
  return signal ? { signal } : {};
}
