/**
 * lib/index.ts — the package's main entry (public repo only).
 *
 * This barrel IS the primary API surface of the `melchizedek-agents`
 * package: what it re-exports is covered by semver; everything else is
 * reachable only through the subpath exports declared in package.json.
 * The cloned repo's npm scripts never import this file — they run the
 * modules directly.
 */

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
export {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
  providerStatuses,
  registerAvailableProviders,
  resolveModel,
} from './models/registry.ts';
export { resolveTools } from './toolRegistry.ts';
export { loadEnv } from './loadEnv.ts';
