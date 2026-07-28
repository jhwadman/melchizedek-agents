/**
 * lib/tools/collectionsSearchTool.ts — xAI Collections search, sentinel-style.
 *
 * WHY this file exists:
 *   xAI's Agent Tools API can search "Collections" — hosted document stores
 *   (PDFs, text, CSVs) uploaded at console.x.ai or via the management API —
 *   semantic RAG run SERVER-SIDE, with citations back to source files
 *   (collections://<collection_id>/files/<file_id>). Declaring
 *   `collections_search` in an agent's YAML tools list turns it on for
 *   grok-* agents; xAI decides retrieval, we never ship documents in the
 *   prompt.
 *
 * HOW IT WORKS (mirrors xSearchTool.ts exactly):
 *   The sentinel self-registers in llmRequest.toolsDict; _getDeclaration()
 *   returns undefined so it is never sent as a client-side function tool.
 *   The GptLlm/GrokLlm request builder calls wantsCollectionsSearch() and
 *   appends the OpenAI-compatible wire shape:
 *     { type: 'file_search', vector_store_ids: [...], max_num_results? }
 *
 * WHICH COLLECTIONS: ids come from the environment, not YAML —
 *   XAI_COLLECTION_IDS (comma-separated) names the collections, and
 *   XAI_COLLECTIONS_MAX_RESULTS optionally caps retrieved chunks. Ids are
 *   deployment configuration (they differ per account/stage), which is
 *   what .env is for; the YAML stays shareable. Declared with no ids
 *   configured, the tool is omitted with a warning — never fatal.
 *
 * SCOPE: xAI-only. OpenAI's Responses API shares the file_search wire
 *   shape but searches OPENAI vector stores — a different product with
 *   different ids — so this sentinel gates to grok-* models and is a
 *   silent no-op everywhere else (same non-throwing routing contract as
 *   web_search / x_search).
 */

import { BaseTool } from '@google/adk';
import type { LlmRequest } from '@google/adk';

import { providerForModel } from '../models/providerMap.ts';

export const COLLECTIONS_SEARCH_TOOL_NAME = 'collections_search';

export class CollectionsSearchTool extends BaseTool {
  constructor() {
    super({
      name: COLLECTIONS_SEARCH_TOOL_NAME,
      description:
        'Semantic search over xAI Collections (hosted document stores) via ' +
        'Agent Tools — grok-* models only; a no-op sentinel on every other ' +
        'provider. Collections are selected by XAI_COLLECTION_IDS.',
    });
  }

  /** Never a client-side function tool — xAI runs retrieval server-side. */
  _getDeclaration(): undefined {
    return undefined;
  }

  /** Server-side tool: nothing to execute locally. */
  async runAsync(): Promise<unknown> {
    return Promise.resolve();
  }

  async processLlmRequest({ llmRequest }: { llmRequest: LlmRequest }): Promise<void> {
    if (!llmRequest.model) return;
    if (providerForModel(llmRequest.model) !== 'xai') return; // no-op elsewhere
    llmRequest.toolsDict[COLLECTIONS_SEARCH_TOOL_NAME] = this;
  }
}

/** Shared instance, mirroring WEB_SEARCH / X_SEARCH. */
export const COLLECTIONS_SEARCH = new CollectionsSearchTool();

/** True when the agent requested collections search (xAI sentinel path). */
export function wantsCollectionsSearch(llmRequest: LlmRequest): boolean {
  return (
    llmRequest.toolsDict?.[COLLECTIONS_SEARCH_TOOL_NAME] instanceof
    CollectionsSearchTool
  );
}

/** Sentinel test used by the request builder to skip function-tool emission. */
export function isCollectionsSearchSentinel(tool: unknown): boolean {
  return tool instanceof CollectionsSearchTool;
}

/** Collection ids from XAI_COLLECTION_IDS (comma-separated, trimmed). */
export function collectionIdsFromEnv(): string[] {
  return (process.env.XAI_COLLECTION_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

/** Optional retrieval cap from XAI_COLLECTIONS_MAX_RESULTS (positive int). */
export function collectionsMaxResultsFromEnv(): number | undefined {
  const raw = process.env.XAI_COLLECTIONS_MAX_RESULTS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
