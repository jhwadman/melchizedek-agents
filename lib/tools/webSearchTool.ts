/**
 * lib/tools/webSearchTool.ts — provider-agnostic web search.
 *
 * WHY this file exists:
 *   ADK's built-in GOOGLE_SEARCH tool is Gemini grounding — it THROWS for any
 *   non-Gemini model. But every cloud provider this framework routes to has
 *   its own native web search: Gemini grounding, Anthropic's web_search
 *   server tool, OpenAI's Responses web_search tool, xAI's live search.
 *   Declaring `web_search` in an agent's YAML tools list routes to whichever
 *   of those the agent's model supports — the YAML stays model-agnostic.
 *
 * HOW IT WORKS:
 *   ADK calls processLlmRequest() on every tool while building the request,
 *   with llmRequest.model already set (LlmAgent resolves the model first).
 *   - Gemini model  → push { googleSearch: {} } into config.tools, exactly
 *     what ADK's own GoogleSearchTool does for Gemini 2+.
 *   - Anything else → self-register in llmRequest.toolsDict as a sentinel.
 *     _getDeclaration() returns undefined, so the sentinel is never sent as
 *     a client-side function tool; each provider adapter calls
 *     wantsWebSearch(llmRequest) and enables its provider's NATIVE search
 *     (Claude: web_search server tool; GPT: Responses web_search; Grok:
 *     Agent Tools web_search). Models with no native search (local Ollama) omit
 *     the tool and warn — local mode stays keyless by design.
 *
 *   `google_search` remains available as the Gemini-only ADK tool for
 *   backward compatibility; new YAMLs should declare `web_search`.
 */

import { BaseTool } from '@google/adk';
import type { LlmRequest } from '@google/adk';

import { providerForModel } from '../models/providerMap.ts';

export const WEB_SEARCH_TOOL_NAME = 'web_search';

export class WebSearchTool extends BaseTool {
  constructor() {
    super({
      name: WEB_SEARCH_TOOL_NAME,
      description:
        "Web search via the agent model's native search capability " +
        '(Gemini grounding / Anthropic web_search / OpenAI web_search / xAI live search).',
    });
  }

  /** Never a client-side function tool — providers run search server-side. */
  _getDeclaration(): undefined {
    return undefined;
  }

  /** Server-side tool: nothing to execute locally. */
  async runAsync(): Promise<unknown> {
    return Promise.resolve();
  }

  async processLlmRequest({ llmRequest }: { llmRequest: LlmRequest }): Promise<void> {
    if (!llmRequest.model) return;

    if (providerForModel(llmRequest.model) === 'gemini') {
      // Native Gemini grounding — same wire shape ADK's GoogleSearchTool
      // emits for Gemini 2+ (we can't reuse that class: it throws for
      // non-Gemini models, and this tool must never throw on routing).
      llmRequest.config = llmRequest.config ?? {};
      llmRequest.config.tools = llmRequest.config.tools ?? [];
      (llmRequest.config.tools as unknown[]).push({ googleSearch: {} });
      return;
    }

    // Non-Gemini: leave a sentinel for the provider adapter. Safe because
    // _getDeclaration() is undefined — ADK's appendTools never adds this
    // to the function-tool declarations sent to the model.
    llmRequest.toolsDict[WEB_SEARCH_TOOL_NAME] = this;
  }
}

/** Shared instance, mirroring ADK's GOOGLE_SEARCH constant pattern. */
export const WEB_SEARCH = new WebSearchTool();

/** True when the agent requested web search (non-Gemini sentinel path). */
export function wantsWebSearch(llmRequest: LlmRequest): boolean {
  return llmRequest.toolsDict?.[WEB_SEARCH_TOOL_NAME] instanceof WebSearchTool;
}

/** True for toolsDict entries adapters must NOT send as function tools. */
export function isWebSearchSentinel(tool: unknown): boolean {
  return tool instanceof WebSearchTool;
}

// ── xAI-only server-side constraints ─────────────────────────────────────────
//
// WHICH CONSTRAINTS (verified against docs.x.ai/developers/tools/web-search,
// 2026-08-08): xAI's web_search accepts domain filters — allowed_domains /
// excluded_domains (≤5 each, mutually exclusive), nested under a `filters`
// object on the OpenAI-compatible wire — plus enable_image_search /
// enable_image_understanding booleans (not plumbed here). Unlike x_search it
// accepts NO from_date/to_date; there is no server-side date bound for web
// results, so timeliness must come from the prompt or from x_search.
//
// Same doctrine as xSearchTool.xSearchParamsFromEnv: constraints are
// deployment configuration (XAI_WEB_SEARCH_ALLOWED_DOMAINS /
// XAI_WEB_SEARCH_EXCLUDED_DOMAINS, comma-separated), never YAML — the YAML
// stays shareable. Misconfiguration degrades with a warning, never fatally:
// oversize domain lists truncate, and when both lists are set the allowlist
// wins. OpenAI's web_search takes no such params — callers must apply this
// helper on the xAI path only.

/** xAI's documented ceiling on allowed_domains / excluded_domains. */
const XAI_WEB_SEARCH_MAX_DOMAINS = 5;

/** Comma-separated domains from an env var; trimmed, capped at xAI's limit. */
function domainsFromEnv(name: string): string[] {
  const domains = (process.env[name] ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.length > XAI_WEB_SEARCH_MAX_DOMAINS) {
    console.warn(
      `[web_search] ${name} lists ${domains.length} domains — xAI caps the ` +
        `list at ${XAI_WEB_SEARCH_MAX_DOMAINS}; keeping the first ${XAI_WEB_SEARCH_MAX_DOMAINS}.`,
    );
    return domains.slice(0, XAI_WEB_SEARCH_MAX_DOMAINS);
  }
  return domains;
}

/**
 * Optional server-side domain filters for xAI's web_search tool, read from
 * the environment at request-build time (see WHICH CONSTRAINTS above). With
 * nothing configured this returns {} and the tool ships bare, exactly as it
 * always has. xAI-only: apply on the xAI path, never on OpenAI's web_search.
 */
export function xaiWebSearchParamsFromEnv(): Record<string, unknown> {
  const allowed = domainsFromEnv('XAI_WEB_SEARCH_ALLOWED_DOMAINS');
  const excluded = domainsFromEnv('XAI_WEB_SEARCH_EXCLUDED_DOMAINS');
  if (allowed.length > 0 && excluded.length > 0) {
    console.warn(
      '[web_search] XAI_WEB_SEARCH_ALLOWED_DOMAINS and _EXCLUDED_DOMAINS are ' +
        'mutually exclusive (xAI rejects both together) — keeping the ' +
        'allowlist, dropping the exclusions.',
    );
  }
  if (allowed.length > 0) return { filters: { allowed_domains: allowed } };
  if (excluded.length > 0) return { filters: { excluded_domains: excluded } };
  return {};
}
