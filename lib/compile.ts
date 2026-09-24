/**
 * lib/compile.ts — the one YAML → ADK agent-graph compiler.
 *
 * WHY this file exists:
 *   The A2A server carried this logic as two closures inside its executor,
 *   and the observatory (observatory/, the eval harness) needs to run the
 *   EXACT graph production runs — same subagent wiring, same tool
 *   resolution, same generateContentConfig merge, same nested
 *   `yaml_reference` handling. A second copy would have been a second place
 *   for the two to drift, which is how toolRegistry.ts came to exist.
 *   So the compiler moved here and both callers import it.
 *
 * What it does NOT own: model resolution and nested-config loading. Both are
 * injected, because the two callers differ precisely there:
 *   - the A2A server resolves `model` to a provider INSTANCE carrying the
 *     caller's BYOK key (lib/models/registry.ts resolveModel);
 *   - the observatory passes the model id through as a string (the
 *     LLMRegistry routes it) and loads nested syndicates with its
 *     per-variant overrides already applied.
 *
 * ── Two orchestration methods, one compiler ───────────────────────────────
 * DELEGATE (no `dispatch:` block): every subagent becomes an AgentTool on
 * the orchestrator. PLAN-DISPATCH (`dispatch:` present): the orchestrator
 * is compiled WITHOUT subagent tools — it is a pure classifier — and the
 * caller runs `compileSubagent(route)` directly for the chosen route. Both
 * paths build subagents through the same function, so the agent a route
 * dispatches to is identical to the one DELEGATE would have wrapped.
 * Contract and rationale: lib/dispatch.ts.
 */

import { AgentTool, LlmAgent } from '@google/adk';
import type { BaseLlm } from '@google/adk';

import { isDispatchSyndicate } from './dispatch.ts';
import { loadSyndicate } from './loadSyndicate.ts';
import type { SubagentYamlConfig, SyndicateYamlConfig } from './loadSyndicate.ts';
import { resolveTools as resolveNamedTools } from './toolRegistry.ts';
import { createMcpTools } from './tools/mcpToolFactory.ts';
import { capabilitySummary, describeCapabilities } from './models/capabilities.ts';

export interface CompileOptions {
  /**
   * Turns the YAML `model` string into what LlmAgent receives. Default:
   * identity — the string goes straight to ADK's LLMRegistry, which needs
   * `registerAvailableProviders()` to have run (lib/models/registry.ts).
   * The A2A server substitutes a BYOK instance factory here.
   */
  resolveModel?: (model: string | undefined) => string | BaseLlm | undefined;
  /**
   * Loads a nested `yaml_reference:` syndicate. Default: `loadSyndicate(ref)`
   * with no bindings — the same call the server makes. The observatory wraps
   * this to apply its variant overrides to nested syndicates too.
   */
  loadNested?: (ref: string) => SyndicateYamlConfig;
  /** Called once per YAML tool name that no registry entry matches. */
  onUnknownTool?: (name: string) => void;
  /** Progress/diagnostic line sink (nested loads, MCP discovery). */
  log?: (message: string) => void;
}

/** generateContentConfig as every entrypoint has always sent it to ADK. */
function withServerSideToolInvocations(
  generateContentConfig: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cfg = (generateContentConfig ?? {}) as Record<string, any>;
  return {
    ...cfg,
    toolConfig: {
      ...(cfg.toolConfig ?? {}),
      includeServerSideToolInvocations: true,
    },
  };
}

/**
 * Says, once per compiled agent, what its resolved path cannot honour — a
 * dropped server-side tool, a gateway stand-in, or no route at all. Quiet
 * for the normal case (funded direct path, nothing dropped). The check runs
 * on the model STRING under the current env, which is the same decision
 * resolveModel makes; a BYOK entrypoint that funds a provider per request
 * reports through its own resolver instead.
 */
function logCapabilities(
  opts: CompileOptions,
  agentName: string,
  model: string | undefined,
  tools: readonly string[] | undefined,
): void {
  if (!opts.log || !model) return;
  const line = capabilitySummary(agentName, describeCapabilities(model, tools ?? []));
  if (line) opts.log(`capability · ${line}`);
}

async function resolveAgentTools(
  toolNames: string[] | undefined,
  mcpServerUrl: string | undefined,
  opts: CompileOptions,
): Promise<unknown[]> {
  const tools = resolveNamedTools(toolNames, opts.onUnknownTool);
  if (mcpServerUrl) {
    opts.log?.(`Loading MCP tools: ${mcpServerUrl}`);
    const mcpTools = await createMcpTools(mcpServerUrl);
    for (const mcpTool of mcpTools) {
      if (!tools.some((t: any) => t.name === mcpTool.name)) tools.push(mcpTool);
    }
  }
  return tools;
}

/**
 * Builds ONE runnable agent from a subagent entry. A `yaml_reference` entry
 * compiles the nested syndicate's whole graph under this entry's name and
 * description, so the parent sees one tool (or one route) either way.
 */
export async function compileSubagent(
  subCfg: SubagentYamlConfig,
  opts: CompileOptions = {},
): Promise<LlmAgent> {
  if (subCfg.yaml_reference) {
    opts.log?.(`Loading nested syndicate: ${subCfg.yaml_reference}`);
    const nested = (opts.loadNested ?? loadSyndicate)(subCfg.yaml_reference);
    return compileGraph(nested, opts, subCfg.name, subCfg.description);
  }

  const tools = await resolveAgentTools(subCfg.tools, subCfg.mcp_server_url, opts);
  const resolveModel = opts.resolveModel ?? ((m) => m);
  logCapabilities(opts, subCfg.name, subCfg.model, subCfg.tools);

  return new LlmAgent({
    name: subCfg.name,
    description: subCfg.description,
    model: resolveModel(subCfg.model) as any,
    instruction: subCfg.instruction,
    tools: tools.length > 0 ? (tools as any[]) : undefined,
    outputSchema: subCfg.outputSchema as any,
    generateContentConfig: withServerSideToolInvocations(
      subCfg.generateContentConfig as Record<string, unknown> | undefined,
    ) as any,
  });
}

/**
 * Compiles a syndicate's orchestrator. In DELEGATE mode its subagents are
 * attached as AgentTools; in PLAN-DISPATCH mode it gets none (ADK refuses
 * outputSchema + AgentTool on one agent — see config/agents/critic.yaml),
 * and the caller dispatches to `compileSubagent(route)` itself.
 */
export async function compileGraph(
  config: SyndicateYamlConfig,
  opts: CompileOptions = {},
  overrideName?: string,
  overrideDescription?: string,
): Promise<LlmAgent> {
  const compiledTools: unknown[] = isDispatchSyndicate(config)
    ? []
    : await Promise.all(
        (config.subagents ?? []).map(
          async (subCfg) => new AgentTool({ agent: await compileSubagent(subCfg, opts) }),
        ),
      );

  // Orchestrator tools are registry names only — no entrypoint has ever
  // attached an MCP server to an orchestrator, and this compiler preserves
  // that exactly rather than widening the contract in passing.
  compiledTools.push(...(await resolveAgentTools(config.orchestrator.tools, undefined, opts)));
  const resolveModel = opts.resolveModel ?? ((m) => m);
  logCapabilities(
    opts,
    overrideName || config.orchestrator.name,
    config.orchestrator.model,
    config.orchestrator.tools,
  );

  return new LlmAgent({
    name: overrideName || config.orchestrator.name,
    description: overrideDescription || config.orchestrator.description,
    model: resolveModel(config.orchestrator.model) as any,
    instruction: config.orchestrator.instruction,
    tools: compiledTools.length > 0 ? (compiledTools as any[]) : undefined,
    outputSchema: config.orchestrator.outputSchema as any,
    generateContentConfig: withServerSideToolInvocations(
      config.orchestrator.generateContentConfig as Record<string, unknown> | undefined,
    ) as any,
  });
}
