/**
 * lib/observability/metrics.ts — Prometheus metrics for the A2A server
 * (ADR 0026), from one record per finished task. No dependency: the text
 * exposition format is a few lines.
 *
 * Labels are the agent, the outcome and the caller name. A caller name is
 * an operator-chosen identifier (a caller token's name, 'shared-secret',
 * 'jwt' or 'jwt:<tenant>'), never a user id, so the label set stays small
 * and holds no personal data. Scopes are never a label.
 */

/** One finished (or refused) task, as the executor reports it. */
export interface TaskRecord {
  /** The agent id the task was sent to; '' is the default syndicate. */
  agentId: string;
  syndicate: string;
  caller?: string;
  /** SHA-256 prefix of the scope key: joins log lines without naming a user. */
  scopeHash: string;
  status: 'completed' | 'failed' | 'canceled' | 'rejected';
  /** Why a task was rejected or failed: 'policy', 'capacity', 'input', or the turn's error code. */
  reason?: string;
  durationMs: number;
  usage: { llmCalls: number; inputTokens: number; outputTokens: number; thinkingTokens: number };
}

const BUCKETS = [1, 2.5, 5, 10, 20, 40, 60, 120, 300, 900];

type Labels = Record<string, string>;
const key = (l: Labels) => JSON.stringify(Object.entries(l).sort(([a], [b]) => a.localeCompare(b)));
const fmt = (l: Labels) =>
  Object.keys(l).length
    ? `{${Object.entries(l)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`)
        .join(',')}}`
    : '';

export interface Metrics {
  observeTask(record: TaskRecord): void;
  /** Prometheus text exposition. `inFlight` is read at scrape time. */
  render(inFlight?: number): string;
}

export function createMetrics(): Metrics {
  const counters = new Map<string, Map<string, { labels: Labels; value: number }>>();
  const hist = new Map<string, { labels: Labels; buckets: number[]; sum: number; count: number }>();
  const inc = (name: string, labels: Labels, by = 1) => {
    if (!by) return;
    const series = counters.get(name) ?? new Map();
    counters.set(name, series);
    const k = key(labels);
    const cur = series.get(k) ?? { labels, value: 0 };
    cur.value += by;
    series.set(k, cur);
  };
  const HELP: Record<string, [string, string]> = {
    melchizedek_a2a_tasks_total: ['counter', 'Tasks finished or refused, by agent, outcome and caller.'],
    melchizedek_a2a_llm_calls_total: ['counter', 'Model calls made by tasks.'],
    melchizedek_a2a_tokens_total: ['counter', 'Tokens reported by the providers, by kind (input, output, thinking).'],
    melchizedek_a2a_task_duration_seconds: ['histogram', 'Wall-clock duration of tasks that ran.'],
    melchizedek_a2a_tasks_in_flight: ['gauge', 'Tasks running now.'],
  };
  return {
    observeTask(r) {
      const base = { agent: r.agentId || 'default', caller: r.caller ?? 'none' };
      inc('melchizedek_a2a_tasks_total', { ...base, status: r.status, reason: r.reason ?? '' });
      inc('melchizedek_a2a_llm_calls_total', base, r.usage.llmCalls);
      inc('melchizedek_a2a_tokens_total', { ...base, kind: 'input' }, r.usage.inputTokens);
      inc('melchizedek_a2a_tokens_total', { ...base, kind: 'output' }, r.usage.outputTokens);
      inc('melchizedek_a2a_tokens_total', { ...base, kind: 'thinking' }, r.usage.thinkingTokens);
      if (r.status === 'rejected') return;
      const labels = { agent: base.agent };
      const k = key(labels);
      const h = hist.get(k) ?? { labels, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
      const secs = r.durationMs / 1000;
      BUCKETS.forEach((b, i) => {
        if (secs <= b) h.buckets[i] += 1;
      });
      h.sum += secs;
      h.count += 1;
      hist.set(k, h);
    },
    render(inFlight) {
      const out: string[] = [];
      const head = (name: string) => {
        const [type, help] = HELP[name];
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      };
      for (const name of ['melchizedek_a2a_tasks_total', 'melchizedek_a2a_llm_calls_total', 'melchizedek_a2a_tokens_total']) {
        head(name);
        for (const { labels, value } of counters.get(name)?.values() ?? []) out.push(`${name}${fmt(labels)} ${value}`);
      }
      const hn = 'melchizedek_a2a_task_duration_seconds';
      head(hn);
      for (const h of hist.values()) {
        BUCKETS.forEach((b, i) => out.push(`${hn}_bucket${fmt({ ...h.labels, le: String(b) })} ${h.buckets[i]}`));
        out.push(`${hn}_bucket${fmt({ ...h.labels, le: '+Inf' })} ${h.count}`);
        out.push(`${hn}_sum${fmt(h.labels)} ${h.sum}`, `${hn}_count${fmt(h.labels)} ${h.count}`);
      }
      if (inFlight !== undefined) {
        head('melchizedek_a2a_tasks_in_flight');
        out.push(`melchizedek_a2a_tasks_in_flight ${inFlight}`);
      }
      return `${out.join('\n')}\n`;
    },
  };
}
