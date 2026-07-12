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
import { generateImageTool } from './tools/generateImageTool.ts';
import { inspectImageTool } from './tools/inspectImageTool.ts';

const TOOL_MAP: Record<string, unknown> = {
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
