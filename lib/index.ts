/**
 * lib/index.ts — the package's main entry (public repo only).
 *
 * This barrel IS the primary API surface of the `melchizedek-agents`
 * package: what it re-exports is covered by semver; everything else is
 * reachable only through the subpath exports declared in package.json.
 * The cloned repo's npm scripts never import this file — they run the
 * modules directly.
 *
 * The run API is plain data in, plain data out: a YAML config and text
 * parts go in, a SyndicateTurnResult comes out. Google ADK runs underneath
 * (a peer dependency) but its types are not part of what you write against.
 */

// ── Load a syndicate ────────────────────────────────────────────────────────
export {
  loadSyndicate,
  loadSyndicateFromRegistry,
  parseCliBindings,
  validateRegistryConfig,
} from './loadSyndicate.ts';
export type {
  AgentYamlConfig,
  LoadSyndicateOptions,
  SubagentYamlConfig,
  SyndicateYamlConfig,
  VariableMap,
} from './loadSyndicate.ts';

// ── Run it ──────────────────────────────────────────────────────────────────
export { runSyndicateTurn, ingestTurnMemory } from './runtime/syndicateTurn.ts';
export type {
  DrainedRun,
  MessagePart,
  RouteDecision,
  SyndicateTurnOptions,
  SyndicateTurnResult,
  TraceOptions,
  TurnEvents,
  TurnStage,
} from './runtime/syndicateTurn.ts';
export { compileGraph, compileSubagent } from './compile.ts';
export type { CompileOptions } from './compile.ts';

// ── Serve it over A2A, or call a remote A2A agent ───────────────────────────
export { createA2AApp, compileAgentCard } from './a2a/app.ts';
export type { A2AApp, A2AAppOptions, RequestIdentity } from './a2a/app.ts';
export type { A2AContext } from './a2a/executor.ts';
export { RemoteA2AAgent, remoteAgentTool } from './a2a/remoteAgent.ts';
export type { RemoteAnswer } from './a2a/remoteAgent.ts';

// ── Extend it ───────────────────────────────────────────────────────────────
export { resolveTools, registerTool, registeredToolNames } from './toolRegistry.ts';
export { registerGuard, resolveGuards } from './guards/index.ts';
export type { Guard, GuardResult } from './guards/index.ts';
export { defineTool, toFunctionTool } from './tools/toolContract.ts';

// ── Memory ──────────────────────────────────────────────────────────────────
export {
  modelExtractor,
  geminiEmbedder,
  openAiCompatibleEmbedder,
  memoryProvidersFromEnv,
} from './memory/providers.ts';
export type { Embedder, MemoryExtractor } from './memory/providers.ts';
export { eraseScope } from './memory/erase.ts';
export type { EraseCounts } from './memory/erase.ts';
export { namespacedMemoryService } from './memory/namespace.ts';

// ── Storage (ADR 0021) ──────────────────────────────────────────────────────
export { postgresStorage, PostgresSessionService, PostgresTaskStore } from './storage/postgres/index.ts';
export type { PostgresStorage, PostgresStorageOptions } from './storage/postgres/index.ts';
export type { MemoryStore } from './memory/store.ts';

// ── Validation ──────────────────────────────────────────────────────────────
export { validateSyndicateConfig, syndicateJsonSchema, SyndicateValidationError } from './syndicateSchema.ts';

// ── Models ──────────────────────────────────────────────────────────────────
export {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
  providerStatuses,
  registerAvailableProviders,
  resolveModel,
  // Listed as root exports in the 0.12.0 changelog but shipped only as a
  // subpath until 0.16.0.
  describeCapabilities,
  capabilitySummary,
  planTransport,
  gatewayConfig,
  gatewayProblem,
  gatewayUsable,
  GATEWAYS,
  GatewayLlm,
} from './models/registry.ts';

export { loadEnv } from './loadEnv.ts';
