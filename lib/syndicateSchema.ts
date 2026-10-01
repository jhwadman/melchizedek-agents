/**
 * lib/syndicateSchema.ts — the syndicate YAML contract, as a validator.
 *
 * WHY this file exists:
 *   A syndicate YAML is the framework's primary authoring surface, and the
 *   loader used to type-cast it (`parse(...) as SyndicateYamlConfig`). A typo
 *   either crashed deep inside the compiler (`orchestator:` → "cannot read
 *   'model' of undefined") or, worse, was accepted and silently changed
 *   behaviour (`memory_system: internl-only` disabled memory in the A2A
 *   server). Here the shape the interfaces in lib/loadSyndicate.ts declare is
 *   written once as a zod schema, checked at load, and every problem is
 *   reported with its key path and, for a misspelt key, the key it was meant
 *   to be.
 *
 *   The same schema emits config/agents/syndicate.schema.json (npm run
 *   schema:gen) so an editor can flag the typo before a run does; a test
 *   keeps the committed file equal to the generated one.
 *
 * Strictness is deliberate at the syndicate, agent and dispatch levels — the
 * places a misspelt key silently does nothing — and deliberately ABSENT inside
 * `generateContentConfig` and `outputSchema`, which pass through to provider
 * SDKs whose fields this repo does not own.
 */

import { z } from 'zod';

import type { SyndicateYamlConfig } from './loadSyndicate.ts';

// ── Leaf rules ───────────────────────────────────────────────────────────────

/**
 * ADK's own rule (validateAgentName in @google/adk base_agent): checked here
 * so the error names the YAML key instead of surfacing from a constructor
 * mid-compile.
 */
const AGENT_NAME_RE = /^[\p{ID_Start}$_][\p{ID_Continue}$_-]*$/u;

const agentName = z
  .string()
  .regex(AGENT_NAME_RE, 'must be a valid identifier (letters, digits, _ and -; not starting with a digit)')
  .refine((n) => n !== 'user', "'user' is reserved by ADK for the end user's input")
  .describe('Unique agent name within the tree. A valid identifier; cannot be "user".');

export const MEMORY_SYSTEMS = ['internal-only', 'session-only', 'long-term'] as const;

const thinkingConfig = z
  .looseObject({
    thinkingBudget: z.number().int().optional().describe('Reasoning token budget. 0 = off, -1 = dynamic.'),
    includeThoughts: z.boolean().optional().describe('Stream the thinking trace in the response.'),
  })
  .describe('Gemini thinking controls (generateContentConfig.thinkingConfig).');

/**
 * Loose on purpose: provider-specific fields (e.g. `toolConfig`) pass through
 * to the SDK. Only the documented fields are typed, so `temperature: hot`
 * still fails while an unlisted knob does not.
 */
const generateContentConfig = z
  .looseObject({
    temperature: z.number().optional(),
    topP: z.number().optional(),
    topK: z.number().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    stopSequences: z.array(z.string()).optional(),
    candidateCount: z.number().int().positive().optional(),
    presencePenalty: z.number().optional(),
    frequencyPenalty: z.number().optional(),
    seed: z.number().int().optional(),
    responseMimeType: z.string().optional(),
    safetySettings: z
      .array(z.looseObject({ category: z.string(), threshold: z.string() }))
      .optional(),
    thinkingConfig: thinkingConfig.optional(),
  })
  .describe('Model generation config (@google/genai GenerateContentConfig). Do not set tools here.');

// ── Agents ───────────────────────────────────────────────────────────────────

const agentFields = {
  name: agentName,
  description: z
    .string()
    .optional()
    .describe('One line other agents read to decide when to delegate here.'),
  model: z
    .string()
    .min(1)
    .describe('Model id; its prefix picks the provider (gemini-*, claude-*, gpt-*/o*, grok-*, ollama/*).'),
  instruction: z.string().min(1).describe('System prompt / persona.'),
  globalInstruction: z
    .string()
    .optional()
    .describe('Instruction applied to every agent in the tree; only the root agent\'s value takes effect.'),
  tools: z
    .array(z.string().min(1))
    .optional()
    .describe('Named tools from lib/toolRegistry.ts (e.g. web_search, web_extract, wiki_search).'),
  includeContents: z
    .enum(['default', 'none'])
    .optional()
    .describe('"default" = include conversation history, "none" = stateless.'),
  disallowTransferToParent: z.boolean().optional(),
  disallowTransferToPeers: z.boolean().optional(),
  outputKey: z.string().optional().describe('Session-state key the final reply is saved under.'),
  generateContentConfig: generateContentConfig.optional(),
  outputSchema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('JSON Schema for structured output. Cannot be combined with AgentTool delegation.'),
  mcp_server_url: z
    .string()
    .optional()
    .describe('MCP server (SSE) whose tools are discovered at runtime and merged with `tools`.'),
  orchestration: z
    .strictObject({
      role: z.enum(['primary', 'sub-agent']).optional(),
      delegates: z.array(z.string()).optional(),
    })
    .optional(),
};

export const agentSchema = z
  .strictObject(agentFields)
  .describe('The root agent (ADK LlmAgentConfig).');

/**
 * Model and instruction are optional at the type level because a nested
 * (`yaml_reference`) or remote (`a2a_agent_url`) subagent brings its own; the
 * "an ordinary subagent needs an instruction" rule is checked in
 * crossFieldProblems so it can name the alternative keys in its message.
 */
export const subagentSchema = z
  .strictObject({
    ...agentFields,
    description: z
      .string()
      .min(1)
      .describe('Required: the orchestrator reads it to decide when to call this subagent.'),
    model: agentFields.model.optional().describe('Model id. Inherits the orchestrator\'s when omitted.'),
    instruction: agentFields.instruction.optional(),
    yaml_reference: z
      .string()
      .min(1)
      .optional()
      .describe('A whole nested syndicate (filename under the agents dir) used as this subagent.'),
    a2a_agent_url: z
      .string()
      .min(1)
      .optional()
      .describe(
        'A remote agent over A2A: the server base URL or its agent-card URL. Needs no model or instruction; credentials come from A2A_AGENT_TOKENS, never YAML.',
      ),
  })
  .describe('A subagent: an inline agent, a nested syndicate (yaml_reference), or a remote A2A agent (a2a_agent_url).');

// ── Dispatch ─────────────────────────────────────────────────────────────────

const routeOverride = z.strictObject({
  route: z.string().min(1).describe('Subagent to run on a match.'),
  pattern: z.string().min(1).describe('JS regular expression source tested against the raw message.'),
  flags: z.string().optional().describe('Regex flags. Default "i".'),
  reason: z.string().optional().describe('Shown to the waiting user as the [STATUS] route note.'),
});

const dispatchSchema = z
  .strictObject({
    default_route: z
      .string()
      .min(1)
      .describe('Subagent used whenever routing yields no usable answer. Must name a declared subagent.'),
    route_key: z.string().optional().describe('JSON property holding the chosen route. Default "route".'),
    reason_key: z.string().optional().describe('JSON property holding the justification. Default "reason".'),
    route_overrides: z.array(routeOverride).optional(),
  })
  .describe('Opts into PLAN-DISPATCH orchestration (lib/dispatch.ts).');

// ── Syndicate ────────────────────────────────────────────────────────────────

export const syndicateSchema = z
  .strictObject({
    syndicate_name: z.string().min(1).describe('Display name for this syndicate.'),
    orchestrator: agentSchema,
    subagents: z
      .array(subagentSchema)
      .describe('The orchestrator\'s team. Use `subagents: []` for a single-agent syndicate.'),
    dispatch: dispatchSchema.optional(),
    variables: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .describe('Defaults for {{token}} interpolation. {{current_date}} is built in.'),
    memory_system: z
      .enum(MEMORY_SYSTEMS)
      .optional()
      .describe('Persistence and semantic-memory layer.'),
    guards: z
      .array(z.string().min(1))
      .optional()
      .describe('Post-answer guards by name (lib/guards/index.ts).'),
    memory_namespace: z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,96}$/, 'letters, digits, ".", "_" and "-" only (max 96)')
      .optional()
      .describe('Where long-term memory is stored: the syndicate name plus a generated id, written once and never recomputed (ADR 0020). Syndicates that declare the same namespace share memory.'),
    memory_extraction_rules: z
      .string()
      .optional()
      .describe('Domain rules appended to the fact-extraction prompt (long-term memory only).'),
    max_steps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Hard cap on runner loops (LLM → tool cycles).'),
  })
  .describe('A Melchizedek syndicate definition (lib/loadSyndicate.ts).');

// ── Did-you-mean ─────────────────────────────────────────────────────────────

/** Optimal-string-alignment distance: a transposition ("modle") costs 1. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The closest candidate, if it is close enough to be a typo. Case and
 * snake/camel drift (`output_key` for `outputKey`) count as an exact match.
 */
export function suggest(input: string, candidates: readonly string[]): string | undefined {
  const norm = (s: string) => s.replace(/[_-]/g, '').toLowerCase();
  const exact = candidates.find((c) => norm(c) === norm(input));
  if (exact) return exact;
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const dist = editDistance(input.toLowerCase(), c.toLowerCase());
    if (dist < bestD) {
      best = c;
      bestD = dist;
    }
  }
  // The second bound stops a one-letter name "suggesting" another one-letter
  // name: replacing every character is not a typo.
  return best !== undefined &&
    bestD <= Math.max(2, Math.floor(best.length / 3)) &&
    bestD < Math.max(input.length, best.length)
    ? best
    : undefined;
}

// ── Reporting ────────────────────────────────────────────────────────────────

type Path = readonly PropertyKey[];

function formatPath(p: Path): string {
  let out = '';
  for (const seg of p) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || '(root)';
}

/** The strict object whose keys are valid at `p`, for did-you-mean. */
function knownKeysAt(p: Path): readonly string[] {
  const key = p.map((s) => (typeof s === 'number' ? '#' : String(s))).join('/');
  switch (key) {
    case '':
      return Object.keys(syndicateSchema.shape);
    case 'orchestrator':
      return Object.keys(agentSchema.shape);
    case 'subagents/#':
      return Object.keys(subagentSchema.shape);
    case 'dispatch':
      return Object.keys(dispatchSchema.shape);
    case 'dispatch/route_overrides/#':
      return Object.keys(routeOverride.shape);
    case 'orchestrator/orchestration':
    case 'subagents/#/orchestration':
      return ['role', 'delegates'];
    default:
      return [];
  }
}

function valueAt(root: unknown, p: Path): unknown {
  let cur: unknown = root;
  for (const seg of p) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg as PropertyKey];
  }
  return cur;
}

function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'a list';
  if (typeof v === 'object') return 'a mapping';
  if (typeof v === 'string') return JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v);
  return String(v);
}

interface Problem {
  path: Path;
  message: string;
  /** Unknown keys sort first: "orchestator — did you mean orchestrator?" explains the "orchestrator — required" after it. */
  typo?: boolean;
}

function problemsFromIssues(issues: readonly z.core.$ZodIssue[], raw: unknown): Problem[] {
  const out: Problem[] = [];
  for (const issue of issues) {
    const p = issue.path as Path;
    if (issue.code === 'unrecognized_keys') {
      const known = knownKeysAt(p);
      for (const k of issue.keys) {
        const hint = suggest(k, known);
        out.push({
          path: [...p, k],
          message: `unknown key${hint ? ` (did you mean "${hint}"?)` : ''}`,
          typo: true,
        });
      }
      continue;
    }
    const got = valueAt(raw, p);
    if (issue.code === 'invalid_type' && got === undefined) {
      out.push({ path: p, message: 'required' });
      continue;
    }
    if (issue.code === 'invalid_value') {
      const values = issue.values.map(String);
      const hint = typeof got === 'string' ? suggest(got, values) : undefined;
      out.push({
        path: p,
        message:
          `must be one of ${values.join(' | ')} (got ${describeValue(got)}` +
          (hint ? ` — did you mean "${hint}"?)` : ')'),
      });
      continue;
    }
    if (issue.code === 'invalid_type') {
      out.push({ path: p, message: `expected ${issue.expected}, got ${describeValue(got)}` });
      continue;
    }
    if (issue.code === 'too_small' && issue.origin === 'string') {
      out.push({ path: p, message: 'must not be empty' });
      continue;
    }
    if (issue.code === 'too_small' && issue.origin === 'number') {
      out.push({ path: p, message: `must be a positive integer (got ${describeValue(got)})` });
      continue;
    }
    out.push({ path: p, message: issue.message });
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Same normalisation lib/dispatch.ts uses to match a route to a subagent. */
const routeNorm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

/**
 * Rules that span fields, which a JSON Schema an editor reads cannot express
 * cleanly. Defensive about shape: runs on raw input alongside zod, so a file
 * with a type error still gets its cross-field problems listed in one pass.
 */
function crossFieldProblems(raw: unknown): Problem[] {
  const out: Problem[] = [];
  if (!isObj(raw)) return out;
  const subs = Array.isArray(raw.subagents) ? raw.subagents : [];

  subs.forEach((sub, i) => {
    if (!isObj(sub)) return;
    const hasRef = typeof sub.yaml_reference === 'string';
    const hasRemote = typeof sub.a2a_agent_url === 'string';
    if (hasRef && hasRemote) {
      out.push({
        path: ['subagents', i, 'a2a_agent_url'],
        message: 'cannot be combined with yaml_reference — a subagent is either a nested syndicate or a remote agent',
      });
    }
    if (!hasRef && !hasRemote && sub.instruction === undefined) {
      out.push({
        path: ['subagents', i, 'instruction'],
        message: 'required (or set yaml_reference / a2a_agent_url for a nested or remote agent)',
      });
    }
    if (hasRemote && !/\{\{\w+\}\}/.test(sub.a2a_agent_url as string)) {
      let ok = false;
      try {
        ok = /^https?:$/.test(new URL(sub.a2a_agent_url as string).protocol);
      } catch {
        ok = false;
      }
      if (!ok) {
        out.push({ path: ['subagents', i, 'a2a_agent_url'], message: 'must be an http(s) URL' });
      }
    }
  });

  // Names must be unique across the tree this file declares: two AgentTools
  // with one name collide, and dispatch routes by name.
  const seen = new Map<string, string>();
  const named: Array<[Path, unknown]> = [
    [['orchestrator', 'name'], isObj(raw.orchestrator) ? raw.orchestrator.name : undefined],
    ...subs.map((s, i): [Path, unknown] => [['subagents', i, 'name'], isObj(s) ? s.name : undefined]),
  ];
  for (const [p, name] of named) {
    if (typeof name !== 'string') continue;
    const first = seen.get(name);
    if (first) out.push({ path: p, message: `duplicate agent name "${name}" (also ${first})` });
    else seen.set(name, formatPath(p));
  }

  if (isObj(raw.dispatch) && typeof raw.dispatch.default_route === 'string') {
    const names = subs.map((s) => (isObj(s) && typeof s.name === 'string' ? s.name : '')).filter(Boolean);
    const target = routeNorm(raw.dispatch.default_route);
    if (!names.some((n) => routeNorm(n) === target)) {
      const hint = suggest(raw.dispatch.default_route, names);
      out.push({
        path: ['dispatch', 'default_route'],
        message:
          `"${raw.dispatch.default_route}" is not a declared subagent` +
          (hint ? ` (did you mean "${hint}"?)` : names.length ? ` (declared: ${names.join(', ')})` : ''),
      });
    }
  }
  return out;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Thrown by validateSyndicateConfig. `problems` holds one `<file>: <path> —
 * <what>` line per problem (the message lists them all); `issues` holds the
 * same lines without the file, for callers that already show it.
 */
export class SyndicateValidationError extends Error {
  readonly file: string | undefined;
  readonly issues: string[];
  readonly problems: string[];
  constructor(issues: string[], file?: string) {
    const problems = issues.map((i) => (file ? `${file}: ${i}` : i));
    super(
      problems.length === 1
        ? problems[0]
        : `${problems.length} problems in syndicate config:\n  ${problems.join('\n  ')}`,
    );
    this.name = 'SyndicateValidationError';
    this.file = file;
    this.issues = issues;
    this.problems = problems;
  }
}

/**
 * Validate a parsed syndicate and return it typed, or throw ONE error that
 * lists every problem as `<file>: <key.path> — <what is wrong>`.
 *
 * Runs on the interpolated config: a `{{token}}` inside a string is still a
 * string, and a full-token number (`max_steps: "{{n}}"`) is checked as the
 * value it resolved to.
 */
export function validateSyndicateConfig(raw: unknown, file?: string): SyndicateYamlConfig {
  if (!isObj(raw)) {
    throw new SyndicateValidationError(
      [`(root) — expected a mapping with syndicate_name, orchestrator and subagents, got ${describeValue(raw)}`],
      file,
    );
  }
  const result = syndicateSchema.safeParse(raw);
  const problems = [
    ...(result.success ? [] : problemsFromIssues(result.error.issues, raw)),
    ...crossFieldProblems(raw),
  ];
  if (problems.length > 0) {
    const ordered = [...problems.filter((p) => p.typo), ...problems.filter((p) => !p.typo)];
    throw new SyndicateValidationError(
      ordered.map((p) => `${formatPath(p.path)} — ${p.message}`),
      file,
    );
  }
  return raw as unknown as SyndicateYamlConfig;
}

/**
 * The syndicate contract as JSON Schema (draft-07: the widest editor
 * support), for `# yaml-language-server: $schema=` and other tooling.
 * Cross-field rules zod expresses as code are added back where JSON Schema
 * can say them, so an editor flags a subagent with no instruction too.
 */
export function syndicateJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(syndicateSchema, {
    target: 'draft-7',
    override: (ctx) => {
      // `\p{ID_Start}` needs the regex `u` flag, which JSON Schema validators
      // do not all apply; the ASCII form only over-warns on non-Latin names,
      // and still catches the common mistake (a space in a name).
      if (ctx.jsonSchema.pattern === AGENT_NAME_RE.source) {
        ctx.jsonSchema.pattern = '^[A-Za-z_$][A-Za-z0-9_$-]*$';
      }
      if (ctx.zodSchema === (subagentSchema as unknown)) {
        ctx.jsonSchema.anyOf = [
          { required: ['instruction'] },
          { required: ['yaml_reference'] },
          { required: ['a2a_agent_url'] },
        ];
        ctx.jsonSchema.not = { required: ['yaml_reference', 'a2a_agent_url'] };
      }
    },
  }) as Record<string, unknown>;
  return { ...schema, title: 'Melchizedek syndicate' };
}
