/**
 * lib/tools/xSearchTool.ts — xAI X (Twitter) search, sentinel-style.
 *
 * WHY this file exists:
 *   xAI's Agent Tools API exposes `x_search` — server-side live search over
 *   X posts — as a first-class tool alongside `web_search` (verified live
 *   against api.x.ai/v1/responses, 2026-07-24). It is the one search
 *   capability no other provider offers, and the reason to route a
 *   news/social agent to a grok-* model at all.
 *
 * HOW IT WORKS (mirrors webSearchTool.ts exactly):
 *   Declaring `x_search` in an agent's YAML tools list self-registers a
 *   sentinel in llmRequest.toolsDict. _getDeclaration() returns undefined so
 *   it is never sent as a client-side function tool; the GptLlm/GrokLlm
 *   request builder calls wantsXSearch(llmRequest) and appends
 *   { type: 'x_search' } to the provider tools.
 *
 * SCOPE: xAI-only. Declare it ONLY on grok-* agents — other Responses-API
 *   providers (OpenAI) reject the unknown tool type with a 400, and Gemini/
 *   Anthropic adapters ignore the sentinel entirely (the tool degrades to a
 *   no-op there rather than throwing, same non-throwing routing contract as
 *   web_search).
 */

import { BaseTool } from '@google/adk';
import type { LlmRequest } from '@google/adk';

import { providerForModel } from '../models/providerMap.ts';

export const X_SEARCH_TOOL_NAME = 'x_search';

export class XSearchTool extends BaseTool {
  constructor() {
    super({
      name: X_SEARCH_TOOL_NAME,
      description:
        'Live search over X (Twitter) posts via xAI Agent Tools — ' +
        'grok-* models only; a no-op sentinel on every other provider.',
    });
  }

  /** Never a client-side function tool — xAI runs the search server-side. */
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
    llmRequest.toolsDict[X_SEARCH_TOOL_NAME] = this;
  }
}

/** Shared instance, mirroring WEB_SEARCH. */
export const X_SEARCH = new XSearchTool();

/** True when the agent requested X search (xAI sentinel path). */
export function wantsXSearch(llmRequest: LlmRequest): boolean {
  return llmRequest.toolsDict?.[X_SEARCH_TOOL_NAME] instanceof XSearchTool;
}

/** Sentinel test used by the request builder to skip function-tool emission. */
export function isXSearchSentinel(tool: unknown): boolean {
  return tool instanceof XSearchTool;
}
