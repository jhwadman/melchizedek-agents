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

const TOOL_MAP: Record<string, unknown> = {
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
      const tool = TOOL_MAP[name];
      if (tool === undefined) {
        onUnknown?.(name);
        return null;
      }
      return tool;
    })
    .filter(Boolean);
}
