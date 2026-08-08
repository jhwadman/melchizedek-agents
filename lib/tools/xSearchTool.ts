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
 *
 * WHICH CONSTRAINTS: xAI accepts server-side search constraints on the tool
 *   object itself (verified against docs.x.ai/developers/tools/x-search,
 *   2026-08-02): from_date/to_date (YYYY-MM-DD) and allowed_x_handles/
 *   excluded_x_handles (≤20 each, mutually exclusive). They come from the
 *   environment, not YAML — XAI_X_SEARCH_FROM_DATE, XAI_X_SEARCH_TO_DATE,
 *   XAI_X_SEARCH_ALLOWED_HANDLES, XAI_X_SEARCH_EXCLUDED_HANDLES (handle
 *   lists comma-separated, leading @ tolerated) — the XAI_COLLECTION_IDS
 *   doctrine: constraints are deployment configuration, the YAML stays
 *   shareable. Misconfiguration degrades with a warning, never fatally:
 *   malformed dates are dropped, oversize handle lists truncate, and when
 *   both lists are set the allowlist wins.
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

/** xAI's documented ceiling on allowed_x_handles / excluded_x_handles. */
const X_SEARCH_MAX_HANDLES = 20;

/** ISO date (YYYY-MM-DD) from an env var; malformed values warn and drop. */
function isoDateFromEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    console.warn(`[x_search] ${name}="${raw}" is not YYYY-MM-DD — ignored.`);
    return undefined;
  }
  return raw;
}

/** Comma-separated handles from an env var; trimmed, @-stripped, capped. */
function handlesFromEnv(name: string): string[] {
  const handles = (process.env[name] ?? '')
    .split(',')
    .map((h) => h.trim().replace(/^@/, ''))
    .filter(Boolean);
  if (handles.length > X_SEARCH_MAX_HANDLES) {
    console.warn(
      `[x_search] ${name} lists ${handles.length} handles — xAI caps the ` +
        `list at ${X_SEARCH_MAX_HANDLES}; keeping the first ${X_SEARCH_MAX_HANDLES}.`,
    );
    return handles.slice(0, X_SEARCH_MAX_HANDLES);
  }
  return handles;
}

/**
 * Optional server-side constraints for the x_search tool, read from the
 * environment at request-build time (see WHICH CONSTRAINTS above). With
 * nothing configured this returns {} and the tool ships bare, exactly as
 * it always has.
 */
export function xSearchParamsFromEnv(): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const from = isoDateFromEnv('XAI_X_SEARCH_FROM_DATE');
  const to = isoDateFromEnv('XAI_X_SEARCH_TO_DATE');
  if (from) params.from_date = from;
  if (to) params.to_date = to;
  const allowed = handlesFromEnv('XAI_X_SEARCH_ALLOWED_HANDLES');
  const excluded = handlesFromEnv('XAI_X_SEARCH_EXCLUDED_HANDLES');
  if (allowed.length > 0 && excluded.length > 0) {
    console.warn(
      '[x_search] XAI_X_SEARCH_ALLOWED_HANDLES and _EXCLUDED_HANDLES are ' +
        'mutually exclusive (xAI rejects both together) — keeping the ' +
        'allowlist, dropping the exclusions.',
    );
  }
  if (allowed.length > 0) params.allowed_x_handles = allowed;
  else if (excluded.length > 0) params.excluded_x_handles = excluded;
  return params;
}
