import { parse } from 'yaml';
import * as fs from 'fs';
import * as path from 'path';
import { createClient } from '@supabase/supabase-js';
import { hasSupabaseCredentials } from './persistence/supabaseProvider.ts';

// ── Types ─────────────────────────────────────────────────
// Property names mirror their ADK counterparts 1:1.
// Sources:
//   LlmAgentConfig      → @google/adk :: agents/llm_agent.d.ts
//   BaseAgentConfig     → @google/adk :: agents/base_agent.d.ts
//   GenerateContentConfig → @google/genai :: GenerateContentConfig

export interface ThinkingConfig {
  /** Token budget for internal reasoning. 0 = off, -1 = dynamic. */
  thinkingBudget?: number;
  /** Stream the thinking trace in the response. */
  includeThoughts?: boolean;
}

export interface SafetySetting {
  category: string;
  threshold: string;
}

/**
 * Maps to GenerateContentConfig from @google/genai.
 * Controls model sampling and generation behaviour.
 * ⚠ Do NOT set `tools` here — use the top-level `tools` field on the agent.
 * ⚠ Do NOT set `thinkingConfig` via the tools param — use this block.
 */
export interface GenerateContentConfig {
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  stopSequences?: string[];
  candidateCount?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  seed?: number;
  responseMimeType?: string;
  safetySettings?: SafetySetting[];
  thinkingConfig?: ThinkingConfig;
}

/**
 * Maps to LlmAgentConfig (+ BaseAgentConfig) from @google/adk.
 */
export interface AgentYamlConfig {
  // ── BaseAgentConfig ──
  /** Unique agent name. Must be a valid JS identifier. Cannot be "user". */
  name: string;
  /** One-line description used by other agents to decide when to delegate here. */
  description?: string;

  // ── LlmAgentConfig ──
  /** Gemini model identifier. Subagents inherit this if not set. */
  model: string;
  /** System prompt / persona. Maps to LlmAgentConfig.instruction. */
  instruction: string;
  /**
   * Global instruction applied to ALL agents in the tree.
   * Only the root agent's value takes effect.
   */
  globalInstruction?: string;
  /**
   * Named built-in tools to attach to this agent.
   * Supported: "google_search", "code_execution"
   * Maps to LlmAgentConfig.tools[].
   */
  tools?: string[];
  /**
   * Whether conversation history is included in model requests.
   * "default" = stateful, "none" = stateless.
   * Maps to LlmAgentConfig.includeContents.
   */
  includeContents?: 'default' | 'none';
  /** Prevents LLM from transferring control back to parent agent. */
  disallowTransferToParent?: boolean;
  /** Prevents LLM from transferring control to peer agents. */
  disallowTransferToPeers?: boolean;
  /**
   * Saves final reply to session state under this key.
   * Useful for chaining agents.
   */
  outputKey?: string;
  /**
   * Model generation config (temperature, topP, safety, thinking, etc.)
   * Maps to LlmAgentConfig.generateContentConfig.
   */
  generateContentConfig?: GenerateContentConfig;
  /**
   * Output schema for structured JSON responses.
   * Maps to LlmAgentConfig.outputSchema.
   */
  outputSchema?: Record<string, unknown>;

  // ── Melchizedek-internal ──
  orchestration?: {
    role?: 'primary' | 'sub-agent';
    delegates?: string[];
  };
}

export interface SubagentYamlConfig extends Partial<AgentYamlConfig> {
  /** Required when used as AgentTool — orchestrator reads this to delegate. */
  name: string;
  description: string;
  yaml_reference?: string;
}

export type VariableMap = Record<string, string | number | boolean>;

export interface SyndicateYamlConfig {
  syndicate_name: string;
  orchestrator: AgentYamlConfig;
  subagents: SubagentYamlConfig[];
  /** Optional default variable definitions for {{token}} interpolation. */
  variables?: VariableMap;
  /** Defines the persistence and semantic memory layer for the syndicate. */
  memory_system?: 'internal-only' | 'session-only' | 'long-term';
  /** Optional hard technical limit for maximum ADK runner loops (LLM -> Tool cycles). */
  max_steps?: number;
}

/**
 * Options for `loadSyndicate()`.
 */
export interface LoadSyndicateOptions {
  /** Variable bindings that resolve `{{token}}` placeholders in the YAML. */
  bindings?: VariableMap;
  /**
   * Direct property overrides applied after binding interpolation.
   */
  overrides?: Partial<SyndicateYamlConfig>;
}

// ── Variable Injection (private) ──────────────────────────

const TOKEN_RE = /\{\{(\w+)\}\}/g;
const FULL_TOKEN_RE = /^\{\{(\w+)\}\}$/;

function interpolateString(
  value: string,
  vars: VariableMap,
): string | number | boolean {
  const fullMatch = value.match(FULL_TOKEN_RE);
  if (fullMatch) {
    const key = fullMatch[1];
    if (key in vars) return vars[key];
    return value;
  }
  return value.replace(TOKEN_RE, (_match, key) => {
    if (key in vars) return String(vars[key]);
    return _match;
  });
}

function interpolateDeep<T>(obj: T, vars: VariableMap): T {
  if (typeof obj === 'string') {
    return interpolateString(obj, vars) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => interpolateDeep(item, vars)) as unknown as T;
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = interpolateDeep(value, vars);
    }
    return result as T;
  }
  return obj;
}

function findUnresolvedTokens(obj: unknown): string[] {
  const tokens = new Set<string>();
  function walk(val: unknown): void {
    if (typeof val === 'string') {
      let m: RegExpExecArray | null;
      TOKEN_RE.lastIndex = 0;
      while ((m = TOKEN_RE.exec(val)) !== null) {
        tokens.add(m[1]);
      }
    } else if (Array.isArray(val)) {
      val.forEach(walk);
    } else if (val !== null && typeof val === 'object') {
      Object.values(val as Record<string, unknown>).forEach(walk);
    }
  }
  walk(obj);
  return [...tokens];
}

function applyOverrides(
  config: SyndicateYamlConfig,
  overrides: Partial<SyndicateYamlConfig>,
): SyndicateYamlConfig {
  return { ...config, ...overrides };
}

/**
 * Bindings every load starts from, resolved at load time so date-anchored
 * prompts never ship a stale hardcoded date. YAML `variables` and caller
 * `bindings` both take precedence.
 */
function defaultBindings(): VariableMap {
  return {
    current_date: new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'America/New_York',
    }),
  };
}

// ── CLI Binding Parser ────────────────────────────────────

function coerce(raw: string): string | number | boolean {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!isNaN(num) && raw !== '') return num;
  return raw;
}

/**
 * Parse CLI variable bindings into a VariableMap.
 *
 * Supports two formats:
 *   --bindings '{"focus_area": "AI Regulation", "headline_count": 10}'
 *   --bind key=value  (individual overrides, take priority over --bindings)
 */
export function parseCliBindings(argv: string[]): VariableMap {
  let vars: VariableMap = {};

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bindings' && i + 1 < argv.length) {
      try {
        const parsed = JSON.parse(argv[i + 1]);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, val] of Object.entries(parsed)) {
            if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
              vars[key] = val;
            }
          }
        }
      } catch {
        console.warn(`⚠ Failed to parse --bindings JSON: ${argv[i + 1]}`);
      }
      i++;
      continue;
    }

    if (argv[i] === '--bind' && i + 1 < argv.length) {
      const pair = argv[i + 1];
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const key = pair.slice(0, eq).trim();
      const raw = pair.slice(eq + 1).trim();
      vars[key] = coerce(raw);
      i++;
    }
  }
  return vars;
}

// ── Primary Entrypoint ────────────────────────────────────

/**
 * Load and fully resolve a syndicate YAML definition.
 *
 * @param filename  YAML filename inside `config/agents/`
 * @param options   Bindings and optional overrides
 *
 * @example
 * ```typescript
 * const config = loadSyndicate('syndicate.yaml', {
 *   bindings: { headline_count: 10 },
 *   overrides: { syndicate_name: 'Custom Council' },
 * });
 * ```
 */
export function loadSyndicate(
  filename: string,
  options: LoadSyndicateOptions = {},
): SyndicateYamlConfig {
  const { bindings = {}, overrides } = options;

  // Security: confine reads to config/agents. `filename` can originate from a
  // network-controlled path segment (see a2a_server dynamic routes), so we must
  // reject any value that resolves outside the agents directory (e.g. "../../.env").
  const agentsDir = path.join(process.cwd(), 'config', 'agents');
  const filePath = path.resolve(agentsDir, filename);
  if (filePath !== agentsDir && !filePath.startsWith(agentsDir + path.sep)) {
    throw new Error(`Invalid syndicate path: '${filename}' resolves outside config/agents`);
  }
  const fileContent = fs.readFileSync(filePath, 'utf-8');
  const raw = parse(fileContent) as SyndicateYamlConfig;

  const merged: VariableMap = {
    ...defaultBindings(),
    ...(raw.variables ?? {}),
    ...bindings,
  };

  const hasVars = Object.keys(merged).length > 0;
  const interpolated = hasVars ? interpolateDeep(raw, merged) : raw;

  if (hasVars) {
    const unresolved = findUnresolvedTokens(interpolated);
    if (unresolved.length > 0) {
      console.warn(
        `⚠ Unresolved template variables: ${unresolved.map(t => `{{${t}}}`).join(', ')}`,
      );
    }
  }

  const { variables: _stripped, ...clean } = interpolated;
  let config = clean as SyndicateYamlConfig;

  if (overrides) {
    config = applyOverrides(config, overrides);
  }

  return config;
}

// ── Registry Validation (Step 7) ──────────────────────────

const VALID_SYSTEM_TOOLS = [
  'google_search',
  'generate_image',
  'load_memory',
  'preload_memory',
  'get_company_fundamentals',
  'get_macro_metrics',
  'get_technical_indicators'
];

/**
 * Validates registry configurations against strict ADK and project constraints.
 */
export function validateRegistryConfig(config: Record<string, any>): void {
  // 1. Enforce native property mapping rules
  if ('options' in config) {
    throw new Error(`[Validation Error] Legacy 'options' object found. Model parameters must reside in 'generateContentConfig'.`);
  }

  // 2. Tool references are resolved at runtime by lib/toolRegistry.ts;
  // unknown names are skipped there with a warning, so no strict
  // validation happens here.

  // 3. Ensure core ADK properties exist
  if (!config.name || (!config.yaml_reference && (!config.model || !config.instruction))) {
    throw new Error(`[Validation Error] Configuration fails validation against ADK LlmAgentConfig specifications.`);
  }
}

/**
 * Loads a syndicate configuration from the Supabase registry.
 * @param registryId The document ID in the adk_agent_registry table
 * @param options Load options (bindings and overrides)
 */
export async function loadSyndicateFromRegistry(
  registryId: string,
  options: LoadSyndicateOptions = {}
): Promise<SyndicateYamlConfig> {
  if (!hasSupabaseCredentials()) {
    throw new Error('Supabase credentials not available for registry loading.');
  }

  const supabaseUrl = process.env.SUPABASE_URL!;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  const { data, error } = await supabase
    .from('adk_agent_registry')
    .select('yaml_content')
    .eq('id', registryId)
    .single();

  if (error || !data) {
    throw new Error(`Registry document ${registryId} not found`);
  }

  const raw = data.yaml_content as SyndicateYamlConfig;
  
  // Validate orchestrator
  validateRegistryConfig(raw.orchestrator);
  // Validate subagents
  for (const sub of raw.subagents || []) {
    validateRegistryConfig(sub);
  }

  const { bindings = {}, overrides } = options;

  const merged: VariableMap = {
    ...defaultBindings(),
    ...(raw.variables ?? {}),
    ...bindings,
  };

  const hasVars = Object.keys(merged).length > 0;
  const interpolated = hasVars ? interpolateDeep(raw, merged) : raw;

  if (hasVars) {
    const unresolved = findUnresolvedTokens(interpolated);
    if (unresolved.length > 0) {
      console.warn(
        `⚠ Unresolved template variables: ${unresolved.map((t: string) => `{{${t}}}`).join(', ')}`,
      );
    }
  }

  const { variables: _stripped, ...clean } = interpolated;
  let config = clean as SyndicateYamlConfig;

  if (overrides) {
    config = applyOverrides(config, overrides);
  }

  return config;
}


