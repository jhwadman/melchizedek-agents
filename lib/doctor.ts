/**
 * lib/doctor.ts — the onboarding walkthrough, generated from the truth.
 *
 * WHY this file exists:
 *   The question every newcomer asks — "which keys do I need?" — used to be
 *   answered by prose in four documents that drift. The doctor answers it
 *   from the YAMLs and the environment: every syndicate the loader can see,
 *   every agent's model, the provider that id routes to, whether that path
 *   is funded (direct key, gateway, or local), and which declared
 *   server-side tools the path will drop. Then it says exactly what to set,
 *   grouped by how much each variable unlocks.
 *
 * WHAT IT NEVER DOES:
 *   - edit .env or any file;
 *   - send a request (demo_model_optionality.ts is the live proof);
 *   - print a key VALUE. Only names of env vars appear (secrets-hygiene).
 *
 * The routing and capability judgments are not re-implemented here: they
 * come from lib/models/gateway.ts and lib/models/capabilities.ts, the same
 * modules the registry and the A2A server use, so the report cannot
 * disagree with what a run would do.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadSyndicate } from './loadSyndicate.ts';
import type { SyndicateYamlConfig } from './loadSyndicate.ts';
import { SyndicateValidationError } from './syndicateSchema.ts';
import { LEGACY_MEMORY_APP_NAME } from './memory/namespace.ts';
import { CAPABILITY_LABELS, capabilityGaps, describeCapabilities } from './models/capabilities.ts';
import type { AgentNeedsInput, CapabilityGap, CapabilityReport } from './models/capabilities.ts';
import {
  GATEWAY_ENV,
  GATEWAY_KEY_ENV,
  GATEWAYS,
  gatewayConfig,
  gatewayProblem,
  gatewayUsable,
} from './models/gateway.ts';
import { PROVIDERS } from './models/providerMap.ts';
import type { ProviderId } from './models/providerMap.ts';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * What a file costs to run: `keyless` (all Ollama), a single provider's id
 * when every agent shares one (`gemini`, `anthropic`, `openai`, `xai` — one
 * key runs it), or `multi-provider` when the models mix.
 */
export type Tier = 'keyless' | Exclude<ProviderId, 'ollama'> | 'multi-provider';

export interface DoctorRow {
  /** Agent name as declared; nested syndicates read "Parent › Child". */
  agent: string;
  role: 'orchestrator' | 'subagent';
  model: string;
  report: CapabilityReport;
  /**
   * What this agent's YAML asks of its model that the resolved path does not
   * fully give it (lib/models/capabilities.ts, ADR 0019). Gaps never block a
   * syndicate; they are printed so a degraded role is not a surprise.
   */
  gaps: CapabilityGap[];
}

export type VerdictState = 'ready' | 'ready-local' | 'via-gateway' | 'blocked';

export interface DoctorSyndicate {
  /** Path relative to the agents dir, e.g. "examples/council.yaml". */
  file: string;
  name: string;
  tier: Tier;
  /** The `# tier:` header comment, when the file declares one. */
  declaredTier?: string;
  rows: DoctorRow[];
  verdict: { state: VerdictState; detail: string };
  /** `npm run <script>` when package.json has an alias for this file. */
  runCommand?: string;
  /**
   * A load, parse or validation error (every problem, one per line). Rows
   * are empty when the file itself failed; a nested failure keeps the rows
   * that did resolve.
   */
  error?: string;
  /**
   * Long-term memory only: the namespace its facts are filed under
   * (ADR 0020), and what is wrong with it, if anything.
   */
  memory?: { namespace: string; declared: boolean; issue?: string };
}

export interface Unlock {
  env: string;
  provider: ProviderId;
  label: string;
  consoleUrl: string;
  /** Syndicates this one variable would move from blocked to ready. */
  syndicates: string[];
}

export interface DoctorResult {
  agentsDir: string;
  syndicates: DoctorSyndicate[];
  unlocks: Unlock[];
  gateway: { id: string; label: string; usable: boolean; problem?: string } | null;
  counts: Record<VerdictState, number>;
}

// ── Where to get a key ───────────────────────────────────────────────────────

export const CONSOLE_URLS: Record<ProviderId, string> = {
  gemini: 'https://aistudio.google.com',
  anthropic: 'https://console.anthropic.com',
  openai: 'https://platform.openai.com/api-keys',
  xai: 'https://console.x.ai',
  ollama: 'https://ollama.com',
};

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Every syndicate file the loader can see: the root (this deployment's
 * live syndicates), examples/ (the starter pack) and templates/ (the
 * production templates). The schema document
 * and evals/ are skipped — one is not a syndicate, the others exist to be
 * measured, not served (config/agents/README.md).
 */
export function listSyndicateFiles(agentsDir: string): string[] {
  const out: string[] = [];
  const yamlIn = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir).sort()) {
      if (!f.endsWith('.yaml') && !f.endsWith('.yml')) continue;
      if (f === 'syndicateSchema.yaml') continue;
      out.push(prefix + f);
    }
  };
  yamlIn(agentsDir, '');
  yamlIn(path.join(agentsDir, 'examples'), 'examples/');
  yamlIn(path.join(agentsDir, 'templates'), 'templates/');
  return out;
}

const TIER_RE = /^#\s*tier:\s*([a-z-]+)/im;

/** The `# tier:` comment in the file's leading comment block, if any. */
export function declaredTierOf(filePath: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
  // Only the header: stop at the first non-comment, non-blank line.
  const header: string[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) header.push(line);
    else break;
  }
  const m = header.join('\n').match(TIER_RE);
  return m ? m[1].toLowerCase() : undefined;
}

/** The tier the models actually imply. */
export function tierOf(rows: readonly DoctorRow[]): Tier {
  const providers = [...new Set(rows.map((r) => r.report.provider))];
  if (providers.length === 0) return 'gemini';
  if (providers.length > 1) return 'multi-provider';
  return providers[0] === 'ollama' ? 'keyless' : providers[0];
}

// ── Diagnosis ────────────────────────────────────────────────────────────────

interface WalkOptions {
  load: (file: string) => SyndicateYamlConfig;
  seen: Set<string>;
  /** Nested `yaml_reference:` files that failed to load or validate. */
  nestedErrors: string[];
}

/** The first problem, without the file prefix the doctor already shows. */
function firstProblem(err: unknown): string {
  if (err instanceof SyndicateValidationError) return err.issues[0] ?? err.message;
  return (err as Error).message.split('\n')[0];
}

/** The capability-relevant fields of one agent's YAML. */
function needsOf(agent: Partial<AgentNeedsInput> & { tools?: string[] }, delegates = false): AgentNeedsInput {
  return {
    tools: agent.tools ?? [],
    outputSchema: agent.outputSchema,
    generateContentConfig: agent.generateContentConfig,
    delegates,
  };
}

function walk(
  config: SyndicateYamlConfig,
  prefix: string,
  opts: WalkOptions,
  rows: DoctorRow[],
): void {
  const orch = config.orchestrator;
  const orchModel = orch?.model;
  if (orch && orchModel) {
    // In DELEGATE mode the orchestrator calls its subagents as tools; under
    // plan-dispatch it is a tool-less classifier and code runs the route.
    const delegates = !config.dispatch && (config.subagents ?? []).length > 0;
    rows.push({
      agent: prefix + orch.name,
      role: 'orchestrator',
      model: orchModel,
      report: describeCapabilities(orchModel, orch.tools ?? []),
      gaps: capabilityGaps(orchModel, needsOf(orch, delegates)),
    });
  }
  for (const sub of config.subagents ?? []) {
    // A remote A2A agent runs its own model on someone else's server; there
    // is no local model to fund or to check.
    if ((sub as { a2a_agent_url?: string }).a2a_agent_url) continue;
    if (sub.yaml_reference) {
      if (opts.seen.has(sub.yaml_reference)) continue;
      opts.seen.add(sub.yaml_reference);
      try {
        walk(opts.load(sub.yaml_reference), `${prefix}${sub.name} › `, opts, rows);
      } catch (err) {
        // Recorded, not just shown as a row: a parent whose nested team
        // cannot load cannot run, so it must not reach the ready verdict.
        opts.nestedErrors.push(`${sub.yaml_reference}: ${firstProblem(err)}`);
        rows.push({
          agent: `${prefix}${sub.name}`,
          role: 'subagent',
          model: `(nested ${sub.yaml_reference} failed to load: ${(err as Error).message})`,
          report: describeCapabilities('gemini-unloadable', []),
          gaps: [],
        });
      }
      continue;
    }
    // A subagent without its own model inherits the orchestrator's.
    const model = sub.model ?? orchModel;
    if (!model) continue;
    rows.push({
      agent: prefix + sub.name,
      role: 'subagent',
      model,
      report: describeCapabilities(model, sub.tools ?? []),
      gaps: capabilityGaps(model, needsOf(sub)),
    });
  }
}

function verdictOf(rows: readonly DoctorRow[]): DoctorSyndicate['verdict'] {
  // A file that resolves to no runnable agent is structurally broken, not
  // ready — the funded checks below are vacuously true on an empty list.
  if (rows.length === 0) return { state: 'blocked', detail: 'invalid — no agents resolved' };
  const blocked = rows.filter((r) => !r.report.funded);
  if (blocked.length > 0) {
    const envs = [...new Set(blocked.map((r) => r.report.keyEnv ?? 'a provider key'))];
    return { state: 'blocked', detail: `set ${envs.join(', ')}` };
  }
  const viaGateway = rows.filter((r) => r.report.transport === 'gateway');
  if (viaGateway.length > 0) {
    const dropped = [...new Set(viaGateway.flatMap((r) => r.report.dropped))];
    const gw = viaGateway[0].report.gateway;
    return {
      state: 'via-gateway',
      detail: dropped.length
        ? `via gateway:${gw}, ${dropped.join(', ')} lost`
        : `via gateway:${gw}`,
    };
  }
  if (rows.length > 0 && rows.every((r) => r.report.provider === 'ollama')) {
    const dropped = [...new Set(rows.flatMap((r) => r.report.dropped))];
    return {
      state: 'ready-local',
      detail: dropped.length ? `local, no ${dropped.join('/')}` : 'local, no key',
    };
  }
  const dropped = [...new Set(rows.flatMap((r) => r.report.dropped))];
  return { state: 'ready', detail: dropped.length ? `${dropped.join(', ')} dropped` : '' };
}

/** `npm run <alias>` for a file, read from package.json scripts. */
export function runCommandFor(
  file: string,
  scripts: Record<string, string> | undefined,
): string | undefined {
  if (!scripts) return undefined;
  const base = path.basename(file).replace(/\.ya?ml$/, '');
  for (const [name, cmd] of Object.entries(scripts)) {
    const m = cmd.match(/--syndicate\s+(\S+)/);
    if (m && m[1].replace(/\.ya?ml$/, '') === base) return `npm run ${name}`;
  }
  return undefined;
}

export function diagnoseSyndicate(
  file: string,
  agentsDir: string,
  scripts?: Record<string, string>,
): DoctorSyndicate {
  const load = (f: string) => loadSyndicate(f, { agentsDir });
  const filePath = path.join(agentsDir, file);
  const declaredTier = declaredTierOf(filePath);
  const runCommand = runCommandFor(file, scripts);
  try {
    const config = load(file);
    const rows: DoctorRow[] = [];
    const nestedErrors: string[] = [];
    walk(config, '', { load, seen: new Set([file, path.basename(file)]), nestedErrors }, rows);
    const memory =
      config.memory_system === 'long-term'
        ? {
            namespace: config.memory_namespace ?? LEGACY_MEMORY_APP_NAME,
            declared: !!config.memory_namespace,
          }
        : undefined;
    return {
      file,
      name: config.syndicate_name ?? path.basename(file),
      tier: tierOf(rows),
      ...(declaredTier ? { declaredTier } : {}),
      rows,
      verdict: nestedErrors.length
        ? { state: 'blocked', detail: `invalid — nested ${nestedErrors[0]}` }
        : verdictOf(rows),
      ...(runCommand ? { runCommand } : {}),
      ...(nestedErrors.length ? { error: nestedErrors.join('\n') } : {}),
      ...(memory ? { memory } : {}),
    };
  } catch (err) {
    // A schema failure is the author's to fix and names the key; anything
    // else (unreadable file, YAML syntax) keeps the old "failed to load".
    const invalid = err instanceof SyndicateValidationError;
    return {
      file,
      name: path.basename(file),
      tier: 'gemini',
      ...(declaredTier ? { declaredTier } : {}),
      rows: [],
      verdict: {
        state: 'blocked',
        detail: invalid ? `invalid — ${firstProblem(err)}` : 'failed to load',
      },
      ...(runCommand ? { runCommand } : {}),
      error: invalid ? err.issues.join('\n') : (err as Error).message,
    };
  }
}

/**
 * ADR 0020: a long-term syndicate declares the namespace its facts are filed
 * under, and two syndicates share memory only by declaring the same one.
 * Checked for the deployment's own files (the agents-dir root). The shipped
 * examples and templates are copied before use, and a copy gets its own
 * namespace from `npm run doctor -- --fix-namespaces <file>`.
 */
export function flagMemoryNamespaces(syndicates: DoctorSyndicate[]): void {
  const own = syndicates.filter((s) => s.memory && !s.file.includes('/'));
  const byNamespace = new Map<string, DoctorSyndicate[]>();
  for (const s of own) {
    const list = byNamespace.get(s.memory!.namespace) ?? [];
    list.push(s);
    byNamespace.set(s.memory!.namespace, list);
  }
  for (const s of own) {
    const m = s.memory!;
    const others = byNamespace.get(m.namespace)!.filter((o) => o !== s).map((o) => o.file);
    if (!m.declared) {
      m.issue =
        `no memory_namespace: facts are filed under the server-wide "${LEGACY_MEMORY_APP_NAME}"` +
        (others.length ? `, shared with ${others.join(', ')}` : '') +
        ` — npm run doctor -- --fix-namespaces ${s.file} (existing facts stay under the old name until re-keyed)`;
    } else if (others.length) {
      m.issue = `memory_namespace "${m.namespace}" is shared with ${others.join(', ')}: these syndicates read and write the same facts`;
    }
  }
}

export function runDoctor(options: {
  agentsDir?: string;
  scripts?: Record<string, string>;
} = {}): DoctorResult {
  const agentsDir = path.resolve(
    options.agentsDir ??
      process.env.MELCHIZEDEK_AGENTS_DIR ??
      path.join(process.cwd(), 'config', 'agents'),
  );
  const syndicates = listSyndicateFiles(agentsDir).map((f) =>
    diagnoseSyndicate(f, agentsDir, options.scripts),
  );

  // Which single variable unlocks what. A syndicate counts toward a
  // variable only when that variable is ALL it is missing.
  const byEnv = new Map<string, Unlock>();
  for (const s of syndicates) {
    if (s.verdict.state !== 'blocked' || s.error) continue;
    const missing = [...new Set(s.rows.filter((r) => !r.report.funded).map((r) => r.report))];
    const envs = [...new Set(missing.map((r) => r.keyEnv).filter((e): e is string => !!e))];
    if (envs.length !== 1) continue;
    const r = missing[0];
    const u = byEnv.get(envs[0]) ?? {
      env: envs[0],
      provider: r.provider,
      label: r.providerLabel,
      consoleUrl: CONSOLE_URLS[r.provider],
      syndicates: [],
    };
    u.syndicates.push(s.name);
    byEnv.set(envs[0], u);
  }
  const unlocks = [...byEnv.values()].sort(
    (a, b) => b.syndicates.length - a.syndicates.length || a.env.localeCompare(b.env),
  );

  const cfg = gatewayConfig();
  const rawGateway = (process.env[GATEWAY_ENV] ?? '').trim();
  const gateway = rawGateway
    ? {
        id: cfg?.gateway.id ?? rawGateway,
        label: cfg?.gateway.label ?? rawGateway,
        usable: gatewayUsable(),
        ...(gatewayProblem() ? { problem: gatewayProblem() } : {}),
      }
    : null;

  const counts: Record<VerdictState, number> = {
    ready: 0,
    'ready-local': 0,
    'via-gateway': 0,
    blocked: 0,
  };
  for (const s of syndicates) counts[s.verdict.state]++;

  flagMemoryNamespaces(syndicates);

  return { agentsDir, syndicates, unlocks, gateway, counts };
}

// ── Rendering ────────────────────────────────────────────────────────────────

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

export function renderDoctor(result: DoctorResult, opts: { color?: boolean } = {}): string {
  const c = opts.color
    ? ANSI
    : (Object.fromEntries(Object.keys(ANSI).map((k) => [k, ''])) as typeof ANSI);
  const lines: string[] = [];
  const paint = (state: VerdictState, text: string) =>
    state === 'blocked'
      ? `${c.red}${text}${c.reset}`
      : state === 'via-gateway'
        ? `${c.yellow}${text}${c.reset}`
        : `${c.green}${text}${c.reset}`;

  lines.push(`${c.bold}melchizedek doctor${c.reset} ${c.dim}· ${result.agentsDir}${c.reset}`);
  lines.push('');

  // Provider line: what is funded, and how.
  const providerBits = (Object.keys(PROVIDERS) as ProviderId[]).map((p) => {
    const r = describeCapabilities(p === 'ollama' ? 'ollama/x' : p === 'gemini' ? 'gemini-x' : p === 'anthropic' ? 'claude-x' : p === 'openai' ? 'gpt-x' : 'grok-x');
    const mark = !r.funded ? `${c.red}✗${c.reset}` : r.transport === 'gateway' ? `${c.yellow}◇${c.reset}` : `${c.green}✓${c.reset}`;
    const how = !r.funded ? `${c.dim}${r.keyEnv} not set${c.reset}` : r.transport === 'gateway' ? `${c.dim}via gateway:${r.gateway}${c.reset}` : p === 'ollama' ? `${c.dim}local${c.reset}` : `${c.dim}direct${c.reset}`;
    return `${mark} ${PROVIDERS[p].label} ${how}`;
  });
  lines.push('providers   ' + providerBits.join('   '));
  if (result.gateway) {
    lines.push(
      result.gateway.problem
        ? `gateway     ${c.red}✗${c.reset} ${result.gateway.problem}`
        : `gateway     ${c.yellow}◇${c.reset} ${result.gateway.label} fills in for any provider whose direct key is absent ${c.dim}(native search is lost on that path)${c.reset}`,
    );
  }
  lines.push('');

  // The table: one line per syndicate (name, verdict, run command), then
  // one indented line per agent.
  const W = { agent: 44, model: 26, prov: 10, needs: 28 };
  lines.push(
    c.dim +
      '  ' +
      pad('agent', W.agent) +
      pad('model', W.model) +
      pad('provider', W.prov) +
      pad('tools (✓ native ✗ dropped)', W.needs) +
      'key' +
      c.reset,
  );
  for (const s of result.syndicates) {
    const head = `${s.name} ${c.dim}(${s.file})${c.reset}`;
    const verdict = paint(s.verdict.state, `${labelOf(s.verdict.state)}${s.verdict.detail ? ` — ${s.verdict.detail}` : ''}`);
    if (s.error) {
      lines.push(`${head}  ${verdict}`);
      const prefix = s.verdict.detail === 'failed to load' ? 'failed to load: ' : '';
      for (const line of s.error.split('\n')) lines.push(`  ${c.red}${prefix}${line}${c.reset}`);
      continue;
    }
    lines.push(`${head}  ${verdict}${s.runCommand ? `  ${c.dim}${s.runCommand}${c.reset}` : ''}`);
    if (s.memory?.issue) {
      lines.push(`  ${c.yellow}⚠ memory: ${s.memory.issue}${c.reset}`);
    }
    if (s.declaredTier && s.declaredTier !== s.tier) {
      lines.push(`  ${c.yellow}⚠ header says "tier: ${s.declaredTier}" but the models say ${s.tier}${c.reset}`);
    }
    for (const r of s.rows) {
      const rep = r.report;
      const needs = [
        ...rep.native.map((t) => `${t}✓`),
        ...rep.dropped.map((t) => `${t}✗`),
      ].join(' ') || '—';
      const key = !rep.funded ? `${c.red}✗ ${rep.keyEnv}${c.reset}` : rep.transport === 'gateway' ? `${c.yellow}◇ gateway${c.reset}` : rep.provider === 'ollama' ? `${c.green}✓ local${c.reset}` : `${c.green}✓${c.reset}`;
      lines.push(
        '  ' +
          pad(r.agent, W.agent) +
          pad(r.model, W.model) +
          pad(rep.provider, W.prov) +
          pad(needs, W.needs) +
          key,
      );
      for (const g of r.gaps) {
        const mark = g.support === 'unsupported' ? `${c.red}✗` : `${c.yellow}◐`;
        lines.push(
          `      ${mark} ${CAPABILITY_LABELS[g.capability]} ${g.support} on ${g.row}${c.reset}${g.note ? ` ${c.dim}— ${g.note}${c.reset}` : ''}`,
        );
      }
    }
  }
  lines.push('');

  // Summary and what to do next.
  const n = result.syndicates.length;
  const ready = result.counts.ready + result.counts['ready-local'];
  lines.push(
    `${c.bold}${ready}/${n} ready${c.reset}` +
      (result.counts['via-gateway'] ? `, ${result.counts['via-gateway']} via gateway` : '') +
      (result.counts.blocked ? `, ${c.red}${result.counts.blocked} blocked${c.reset}` : ''),
  );
  if (result.unlocks.length > 0) {
    lines.push('');
    lines.push(`${c.bold}To unlock more, set in .env:${c.reset}`);
    for (const u of result.unlocks) {
      lines.push(
        `  ${c.cyan}${u.env}${c.reset}  ${c.dim}${u.label} · ${u.consoleUrl}${c.reset}`,
      );
      lines.push(`    unlocks ${u.syndicates.length}: ${u.syndicates.join(', ')}`);
    }
    if (!result.gateway) {
      lines.push('');
      lines.push(
        `  ${c.dim}Or one key for every cloud provider: ${GATEWAY_ENV}=vercel (or openrouter) + ${GATEWAY_KEY_ENV}.${c.reset}`,
      );
      lines.push(
        `  ${c.dim}A gateway serves any id whose direct key is absent, but native search (Gemini grounding, xAI x_search) is lost on that path.${c.reset}`,
      );
      lines.push(
        `  ${c.dim}${Object.values(GATEWAYS).map((g) => `${g.label}: ${g.consoleUrl}`).join(' · ')}${c.reset}`,
      );
    }
  }
  const first = result.syndicates.find(
    (s) => (s.verdict.state === 'ready' || s.verdict.state === 'ready-local') && s.runCommand,
  );
  if (first) {
    lines.push('');
    lines.push(`${c.bold}Try first:${c.reset} ${first.runCommand}  ${c.dim}(${first.name})${c.reset}`);
  }
  lines.push('');
  lines.push(`${c.dim}Read-only. Nothing was sent, nothing was written, no key value is shown.${c.reset}`);
  return lines.join('\n');
}

function labelOf(state: VerdictState): string {
  switch (state) {
    case 'ready':
      return 'ready';
    case 'ready-local':
      return 'ready';
    case 'via-gateway':
      return 'ready';
    case 'blocked':
      return 'blocked';
  }
}
