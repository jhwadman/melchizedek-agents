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
import { WIKI_AGENT_TOOL_CONTRACTS } from './tools/wikiTools.ts';
import { X_SEARCH } from './tools/xSearchTool.ts';

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

const TOOL_MAP: Record<string, unknown> = {
  ...WIKI_TOOLS,
  // Provider-agnostic web search: routes to the model's NATIVE search
  // (Gemini grounding / Anthropic / OpenAI / xAI); omitted with a warning
  // for local models. Prefer this in new YAMLs.
  web_search: WEB_SEARCH,
  x_search: X_SEARCH,
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
