/**
 * lib/a2a/policy.ts — the `policy` plug point (ADR 0017 row 5, ADR 0026):
 * whether a task may start, and what a finished task spent.
 *
 *   createA2AApp({ policy: budgets({ perCaller: { tokens: 2_000_000 } }) })
 *
 * `admit` runs before a task takes a concurrency slot; a refusal ends the
 * task `rejected` with the reason, which a client shows as-is. `record` runs
 * when the task ends, whatever its state: a failed or canceled turn still
 * spent its model calls.
 *
 * The built-in `budgets` counts per UTC day, per caller (`caller:<name>`) and
 * per scope (`scope:<SHA-256 prefix of the scope key>`: the counters hold
 * no user identifier, so erasure has nothing to remove), in a UsageStore: process memory by
 * default, or SQL (`melchizedek_usage`, db/migrations/0004) shared by every
 * instance. A budget is checked at admission against what earlier tasks
 * recorded, so tasks already running when the line is crossed finish: the
 * overshoot is bounded by the concurrency cap, never by the spend of one
 * task being refused halfway.
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { TurnUsage } from '../runtime/syndicateTurn.ts';

/** Who is asking, as the identity middleware resolved it. */
export interface PolicySubject {
  /** The authenticated caller's name ('shared-secret', a caller token's name, 'jwt', …). */
  caller?: string;
  /** The scope key the caller's data lives under. */
  scopeKey: string;
  /** The agent id the task was sent to ('' for the default syndicate). */
  agentId: string;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

export interface Policy {
  /** Before the task runs. Throwing is treated as a refusal (fail closed). */
  admit?(subject: PolicySubject): PolicyDecision | Promise<PolicyDecision>;
  /** After the task, whatever its outcome. Errors are logged, never raised. */
  record?(subject: PolicySubject, usage: TurnUsage): void | Promise<void>;
}

// ── Usage stores ─────────────────────────────────────────────────────────────

export interface DailyUsage {
  tasks: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
}

const ZERO: DailyUsage = { tasks: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

export interface UsageStore {
  /** A subject's totals for one UTC day (YYYY-MM-DD). */
  get(day: string, subject: string): Promise<DailyUsage>;
  /** Add to a subject's totals for one day. */
  add(day: string, subject: string, delta: DailyUsage): Promise<void>;
}

/** Counters in process memory: per instance, lost on restart. Days older than two are dropped. */
export function memoryUsageStore(): UsageStore {
  const rows = new Map<string, DailyUsage>();
  return {
    async get(day, subject) {
      return { ...(rows.get(`${day}|${subject}`) ?? ZERO) };
    },
    async add(day, subject, d) {
      const key = `${day}|${subject}`;
      const cur = rows.get(key) ?? { ...ZERO };
      rows.set(key, {
        tasks: cur.tasks + d.tasks,
        llmCalls: cur.llmCalls + d.llmCalls,
        inputTokens: cur.inputTokens + d.inputTokens,
        outputTokens: cur.outputTokens + d.outputTokens,
        thinkingTokens: cur.thinkingTokens + d.thinkingTokens,
      });
      const oldest = new Date(Date.parse(`${day}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10);
      for (const k of rows.keys()) if (k.slice(0, 10) < oldest) rows.delete(k);
    },
  };
}

const fromRow = (r: any): DailyUsage =>
  r
    ? {
        tasks: Number(r.tasks ?? 0),
        llmCalls: Number(r.llm_calls ?? 0),
        inputTokens: Number(r.input_tokens ?? 0),
        outputTokens: Number(r.output_tokens ?? 0),
        thinkingTokens: Number(r.thinking_tokens ?? 0),
      }
    : { ...ZERO };

/** Counters in Postgres (`melchizedek_usage`), shared by every instance. */
export function postgresUsageStore(pool: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): UsageStore {
  return {
    async get(day, subject) {
      const { rows } = await pool.query(
        'SELECT tasks, llm_calls, input_tokens, output_tokens, thinking_tokens FROM melchizedek_usage WHERE day = $1 AND subject = $2',
        [day, subject],
      );
      return fromRow(rows[0]);
    },
    async add(day, subject, d) {
      await pool.query('SELECT * FROM melchizedek_usage_add($1, $2, $3, $4, $5, $6, $7)', [
        day, subject, d.tasks, d.llmCalls, d.inputTokens, d.outputTokens, d.thinkingTokens,
      ]);
    },
  };
}

/** Counters in a Supabase project's `melchizedek_usage`, through the service-role client. */
export function supabaseUsageStore(client: {
  from: (table: string) => any;
  rpc: (fn: string, args?: Record<string, unknown>) => any;
}): UsageStore {
  return {
    async get(day, subject) {
      const { data, error } = await client
        .from('melchizedek_usage')
        .select('tasks, llm_calls, input_tokens, output_tokens, thinking_tokens')
        .eq('day', day)
        .eq('subject', subject)
        .maybeSingle();
      if (error) throw new Error(`usage read failed: ${error.message}`);
      return fromRow(data);
    },
    async add(day, subject, d) {
      const { error } = await client.rpc('melchizedek_usage_add', {
        p_day: day, p_subject: subject, p_tasks: d.tasks, p_calls: d.llmCalls,
        p_input: d.inputTokens, p_output: d.outputTokens, p_thinking: d.thinkingTokens,
      });
      if (error) throw new Error(`usage write failed: ${error.message}`);
    },
  };
}

// ── Budgets ──────────────────────────────────────────────────────────────────

const limitsSchema = z.strictObject({
  tasks: z.number().int().positive().optional(),
  llmCalls: z.number().int().positive().optional(),
  tokens: z.number().int().positive().optional(),
});
export type BudgetLimits = z.infer<typeof limitsSchema>;

const budgetsSchema = z.strictObject({
  /** Every caller's daily limits, unless overridden by name. */
  perCaller: limitsSchema.optional(),
  /** Limits for named callers, replacing perCaller for them. */
  callers: z.record(z.string(), limitsSchema).optional(),
  /** Every scope's daily limits (one end user, under a caller or a JWT). */
  perScope: limitsSchema.optional(),
});
export type BudgetConfig = z.infer<typeof budgetsSchema>;

/** Parses the A2A_BUDGETS JSON; throws naming the bad key. */
export function parseBudgets(json: string): BudgetConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('A2A_BUDGETS is not valid JSON');
  }
  const r = budgetsSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`A2A_BUDGETS: ${i.path.join('.') || '(root)'} — ${i.message}`);
  }
  return r.data;
}

const today = (now: () => Date) => now().toISOString().slice(0, 10);
/** A scope as a counter subject: hashed, so the usage table holds no user identifier. */
export const scopeSubject = (scopeKey: string) => `scope:${createHash('sha256').update(scopeKey).digest('hex').slice(0, 24)}`;
const tokensOf = (u: DailyUsage) => u.inputTokens + u.outputTokens + u.thinkingTokens;

function over(limits: BudgetLimits | undefined, u: DailyUsage): string | undefined {
  if (!limits) return undefined;
  if (limits.tasks !== undefined && u.tasks >= limits.tasks) return `${limits.tasks} tasks`;
  if (limits.llmCalls !== undefined && u.llmCalls >= limits.llmCalls) return `${limits.llmCalls} model calls`;
  if (limits.tokens !== undefined && tokensOf(u) >= limits.tokens) return `${limits.tokens.toLocaleString('en-US')} tokens`;
  return undefined;
}

/**
 * Daily budgets per caller and per scope. A request is refused when the
 * caller or its scope has reached any limit today (UTC); the message says
 * which and when it resets. A store failure refuses (fail closed) — a
 * budget that cannot be read is not a budget.
 */
export function budgets(config: BudgetConfig, opts: { store?: UsageStore; now?: () => Date } = {}): Policy & { store: UsageStore } {
  const store = opts.store ?? memoryUsageStore();
  const now = opts.now ?? (() => new Date());
  const callerLimits = (caller?: string) => (caller && config.callers?.[caller]) || config.perCaller;
  return {
    store,
    async admit(s) {
      const day = today(now);
      const checks: Array<[string, BudgetLimits | undefined]> = [
        [s.caller ? `caller:${s.caller}` : '', s.caller ? callerLimits(s.caller) : undefined],
        [scopeSubject(s.scopeKey), config.perScope],
      ];
      for (const [subject, limits] of checks) {
        if (!subject || !limits) continue;
        const hit = over(limits, await store.get(day, subject));
        if (hit) {
          const who = subject.startsWith('caller:') ? `Caller '${s.caller}'` : 'This user';
          return { ok: false, reason: `${who} has used today's budget of ${hit}. It resets at 00:00 UTC.` };
        }
      }
      return { ok: true };
    },
    async record(s, usage) {
      const day = today(now);
      const delta: DailyUsage = { tasks: 1, ...usage };
      const writes: Promise<void>[] = [store.add(day, scopeSubject(s.scopeKey), delta)];
      if (s.caller) writes.push(store.add(day, `caller:${s.caller}`, delta));
      await Promise.all(writes);
    },
  };
}
