/**
 * lib/toolRegistry.ts — single source of truth mapping YAML tool names to
 * live ADK tool instances.
 *
 * WHY this exists:
 *   a2a_server.ts and syndicate_chat.ts each carried an identical `resolveTools`
 *   switch. The two copies had already begun to drift. Centralising the mapping
 *   here means a newly added tool is available to every entrypoint at once.
 */

import {
  GOOGLE_SEARCH,
  LOAD_MEMORY,
  PRELOAD_MEMORY,
} from '@google/adk';
import { COLLECTIONS_SEARCH } from './tools/collectionsSearchTool.ts';
import { generateImageTool } from './tools/generateImageTool.ts';
import { inspectImageTool } from './tools/inspectImageTool.ts';
import { toFunctionTool } from './tools/toolContract.ts';
import { WEB_SEARCH } from './tools/webSearchTool.ts';
import { webExtractTool } from './tools/webExtractTool.ts';
import { WIKI_AGENT_TOOL_CONTRACTS } from './tools/wikiTools.ts';
import { SCIENCE_TOOL_CONTRACTS } from './tools/scienceTools.ts';
import { TASK_TOOL_CONTRACTS } from './tools/taskTools.ts';
import { X_SEARCH } from './tools/xSearchTool.ts';
import { xApiSearchTool } from './tools/xApiSearchTool.ts';

// Knowledge-bundle tools, derived from their contracts so the YAML names
// can never drift from the definitions. The agentic composites
// (wiki_query/wiki_garden) are deliberately absent: a syndicate reaches
// that behavior by being an agent WITH these primitives.
const WIKI_TOOLS = Object.fromEntries(
  WIKI_AGENT_TOOL_CONTRACTS.map((contract) => [
    contract.name,
    toFunctionTool(contract),
  ]),
);

// Science tools (lib/tools/scienceTools.ts): read-only literature and
// registry lookups, derived from their contracts the same way, so the YAML
// name IS the contract name. research.yaml declares them.
const SCIENCE_TOOLS = Object.fromEntries(
  SCIENCE_TOOL_CONTRACTS.map((contract) => [contract.name, toFunctionTool(contract)]),
);

// Task list + background-job queue (lib/tools/taskTools.ts): a single-user
// local store. The tools only write the queue; scripts/assistant_worker.ts
// runs the jobs. assistant.yaml declares them.
const TASK_TOOLS = Object.fromEntries(
  TASK_TOOL_CONTRACTS.map((contract) => [contract.name, toFunctionTool(contract)]),
);

// The built-in tools. The wiki build reads these keys from this literal.
// A plain object literal inherits from Object.prototype, so a YAML naming
// `constructor` or `toString` resolved to a prototype function instead of
// the unknown-tool warning; TOOL_MAP below is the null-prototype copy.
const BUILTIN_TOOLS: Record<string, unknown> = {
  ...WIKI_TOOLS,
  ...SCIENCE_TOOLS,
  ...TASK_TOOLS,
  // Provider-agnostic web search: routes to the model's NATIVE search
  // (Gemini grounding / Anthropic / OpenAI / xAI); omitted with a warning
  // for local models. Prefer this in new YAMLs.
  web_search: WEB_SEARCH,
  // Deterministic complement to web_search: client-side URL → clean-text
  // reading (keyless — works on every provider, including local Ollama).
  // augustin.yaml and librarian-style research agents declare it.
  web_extract: webExtractTool,
  x_search: X_SEARCH,
  // X API v2 recent search as a client-side contract, photos transcribed
  // inline — runs on every provider; needs X_BEARER_TOKEN in the server env.
  x_api_search: xApiSearchTool,
  // xAI-only: semantic search over hosted Collections (XAI_COLLECTION_IDS).
  collections_search: COLLECTIONS_SEARCH,
  // Gemini-only ADK grounding tool, kept for backward compatibility.
  google_search: GOOGLE_SEARCH,
  generate_image: generateImageTool,
  inspect_image: inspectImageTool,
  load_memory: LOAD_MEMORY,
  preload_memory: PRELOAD_MEMORY,
};

// Null-prototype copy (as GUARD_MAP is): resolution and registration go
// through this map, never the literal above.
const TOOL_MAP: Record<string, unknown> = Object.assign(Object.create(null), BUILTIN_TOOLS);

/**
 * Resolve an array of tool-name strings to live ADK tool instances.
 * Unknown names are skipped; `onUnknown` (if provided) is invoked for each so
 * callers can log in their own format.
 */
export function resolveTools(
  toolNames: string[] = [],
  onUnknown?: (name: string) => void,
): any[] {
  return toolNames
    .map((name) => {
      const tool = Object.prototype.hasOwnProperty.call(TOOL_MAP, name) ? TOOL_MAP[name] : undefined;
      if (tool === undefined) {
        onUnknown?.(name);
        return null;
      }
      return tool;
    })
    .filter(Boolean);
}

/**
 * Make a tool resolvable by name from a syndicate YAML's `tools:` list.
 *
 * For package consumers: the registry is otherwise closed (YAML can name
 * only what is registered, never load code), and editing this file under
 * node_modules is not an option. Registering is the same deliberate act of
 * exposure as listing a tool above — it happens in your code, where a
 * reviewer reads it. Pass a `defineTool` contract (lib/tools/toolContract.ts)
 * or a ready ADK tool. Replacing a built-in requires `{ override: true }`.
 */
export function registerTool(
  name: string,
  tool: unknown,
  options: { override?: boolean } = {},
): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
    throw new Error(`registerTool: '${name}' is not a valid tool name`);
  }
  if (Object.prototype.hasOwnProperty.call(TOOL_MAP, name) && !options.override) {
    throw new Error(`registerTool: '${name}' is already registered (pass { override: true } to replace it)`);
  }
  const t = tool as Record<string, unknown>;
  const isContract = !!t && typeof t === 'object' && 'schema' in t && typeof t.execute === 'function' && !('runAsync' in t);
  TOOL_MAP[name] = isContract ? toFunctionTool(tool as any) : tool;
}

/** Names a YAML can declare under `tools:` right now. */
export function registeredToolNames(): string[] {
  return Object.keys(TOOL_MAP).sort();
}
