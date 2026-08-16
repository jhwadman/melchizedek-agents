/**
 * Plan-dispatch routing — the second orchestration method.
 *
 * ── The two methods ───────────────────────────────────────────────────────
 * DELEGATE (default, every syndicate without a `dispatch:` block): subagents
 * are AgentTools. The orchestrator calls one, receives its answer as a tool
 * response, and must then RE-EMIT that answer as its own text to close the
 * turn. Classification is implicit in which tool it calls.
 *
 * PLAN-DISPATCH (`dispatch:` block present): the orchestrator holds NO
 * subagent tools at all. It is a pure classifier with an `outputSchema` that
 * names one route. Code reads that name, selects the matching subagent (or
 * nested syndicate) and runs it directly — its output IS the task's answer.
 *
 * ── Why the second method exists ──────────────────────────────────────────
 * The relay turn in DELEGATE mode is a whole LLM call whose only job is to
 * copy text it was explicitly forbidden to edit, and in production it was the
 * least reliable step in the chain: observed failures included finishing with
 * zero output tokens (blank reply) and emitting the bare tool name
 * ("FinancialAnalyst") in place of a 2,599-character answer. PLAN-DISPATCH
 * removes the failure by construction — there is no relay to fail — and drops
 * one LLM round-trip per request, since the router now emits ~15 tokens of
 * JSON instead of re-typing the specialist's whole answer.
 *
 * It also makes the hand-off legible: the route is a value in code, so it can
 * be logged, traced, and streamed to a waiting user as progress. In DELEGATE
 * mode the choice is only ever implicit in a tool call.
 *
 * ── Why the router MUST be tool-less ──────────────────────────────────────
 * ADK refuses to combine `outputSchema` with agent transfer/AgentTool on the
 * same agent (see config/agents/critic.yaml — an orchestrator holding both
 * deadlocks). That constraint is what shapes this design rather than limiting
 * it: the classifier is a leaf, and dispatch happens in code where it belongs.
 *
 * ── Fail-static ───────────────────────────────────────────────────────────
 * Every failure mode here resolves to `default_route` and answers the user.
 * A router that returns malformed JSON, an unknown name, an empty string, or
 * throws outright must never cost the user their reply — the default route is
 * the one that can answer anything (for the financial router, the full
 * consultant). Routing is an optimisation; answering is the contract.
 */

import type { SyndicateYamlConfig, SubagentYamlConfig } from './loadSyndicate.ts';

/** The `dispatch:` block. Its presence switches a syndicate to plan-dispatch. */
export interface DispatchConfig {
  /**
   * Subagent name used whenever routing does not produce a usable answer —
   * malformed output, an unknown route, or a router that failed outright.
   * Must name a subagent that can handle ANY input.
   */
  default_route: string;
  /**
   * Property of the router's JSON holding the chosen route. Default "route".
   */
  route_key?: string;
  /**
   * Property holding the router's short justification, surfaced as progress
   * telemetry while the user waits. Default "reason". Optional in the schema.
   */
  reason_key?: string;
  /**
   * Deterministic pre-classification. Each entry pins a route for messages
   * whose text matches `pattern`; the first match wins and the classifier
   * never runs. For facts the message CONTAINS rather than judgments about
   * what it means — a URL only one specialist can open, an explicit demand
   * for a named tool. Never for topic guesses: a keyword is not a subject.
   */
  route_overrides?: RouteOverride[];
}

/** One deterministic routing rule, evaluated against the user's message. */
export interface RouteOverride {
  /** Subagent to run on a match. Ignored (with a warning) if undeclared. */
  route: string;
  /** JS regular expression source, tested against the raw message text. */
  pattern: string;
  /** Regex flags. Default "i". */
  flags?: string;
  /** Shown to the waiting user in place of the classifier's `reason`. */
  reason?: string;
}

export interface RouteResolution {
  /** Name of the subagent to run. Always a real subagent. */
  route: string;
  /** The router's stated justification, or '' when it gave none. */
  reason: string;
  /** True when routing failed and `default_route` was substituted. */
  fellBack: boolean;
  /** Why the fallback happened — for logs. Empty when routing succeeded. */
  fallbackReason: string;
  /** True when a `route_overrides` rule pinned this route without a model. */
  viaOverride: boolean;
}

/** True when this syndicate opts into plan-dispatch. */
export function isDispatchSyndicate(
  config: SyndicateYamlConfig,
): config is SyndicateYamlConfig & { dispatch: DispatchConfig } {
  return !!config.dispatch && typeof config.dispatch.default_route === 'string';
}

/**
 * Strip a markdown code fence if the model wrapped its JSON in one.
 * `responseMimeType: application/json` normally prevents this, but the
 * resolver stays tolerant so a provider that ignores the hint (or a future
 * non-Gemini router) degrades to a correct route instead of the default.
 */
function unfence(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

/**
 * Match a model-supplied route name against the declared subagents.
 * Comparison ignores case and non-alphanumerics, so "financial analyst",
 * "FinancialAnalyst" and "financial_analyst" all reach the same subagent —
 * the route is a name the model retypes, and punctuation drift is not a
 * reason to lose the user's answer.
 */
function matchSubagent(
  candidate: string,
  subagents: SubagentYamlConfig[],
): SubagentYamlConfig | undefined {
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
  const target = norm(candidate);
  if (!target) return undefined;
  return subagents.find(sub => norm(sub.name) === target);
}

/**
 * Turn the router's raw output into a route that definitely exists.
 *
 * Pure and synchronous — the whole routing contract is unit-testable offline
 * (tests/dispatch.test.ts) with no model, no network and no keys.
 *
 * @param rawOutput  The router agent's text output (expected: one JSON object)
 * @param config     The dispatch syndicate's config
 */
export function resolveRoute(
  rawOutput: string,
  config: SyndicateYamlConfig & { dispatch: DispatchConfig },
): RouteResolution {
  const subagents = config.subagents || [];
  const routeKey = config.dispatch.route_key || 'route';
  const reasonKey = config.dispatch.reason_key || 'reason';

  // The default must itself be a real subagent. When it is not, the config is
  // wrong and the first subagent is the only safe answer left — surfaced as a
  // fallbackReason so it reaches the logs rather than failing silently.
  const declaredDefault = matchSubagent(config.dispatch.default_route, subagents);
  const safeDefault = declaredDefault?.name ?? subagents[0]?.name ?? '';
  const defaultResolution = (fallbackReason: string): RouteResolution => ({
    route: safeDefault,
    reason: '',
    fellBack: true,
    viaOverride: false,
    fallbackReason: declaredDefault
      ? fallbackReason
      : `${fallbackReason}; default_route '${config.dispatch.default_route}' is not a declared subagent`,
  });

  if (!rawOutput || !rawOutput.trim()) {
    return defaultResolution('router returned no output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfence(rawOutput));
  } catch {
    return defaultResolution(`router output was not JSON: ${rawOutput.trim().slice(0, 80)}`);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return defaultResolution('router output was not a JSON object');
  }

  const record = parsed as Record<string, unknown>;
  const rawRoute = record[routeKey];
  if (typeof rawRoute !== 'string' || !rawRoute.trim()) {
    return defaultResolution(`router output has no '${routeKey}' string`);
  }

  const matched = matchSubagent(rawRoute, subagents);
  if (!matched) {
    return defaultResolution(`router chose unknown route '${rawRoute}'`);
  }

  const rawReason = record[reasonKey];
  return {
    route: matched.name,
    reason: typeof rawReason === 'string' ? rawReason.trim() : '',
    fellBack: false,
    fallbackReason: '',
    viaOverride: false,
  };
}

/**
 * Deterministic routing, evaluated BEFORE the classifier runs.
 *
 * Some routes are decided by what a message CONTAINS, not by what a model
 * judges it to be about. An x.com link is the motivating case: XScout is the
 * only route that can open X, so a message carrying one has exactly one
 * correct destination — yet a flash-lite classifier reading "analyze this
 * post and tell me if the solution is quantum <link>" saw an analysis
 * request and chose the consultant, which answered from web knowledge and
 * said the post could not be read (2026-08-15, twice, with the routing rule
 * already stating the opposite). Prompt text competes with the rest of the
 * message; a regex does not.
 *
 * Scope discipline: overrides are for facts in the text, never topic
 * guesses. A misapplied override is worse than a misroute — it cannot be
 * reasoned around by the classifier at all.
 *
 * Pure and synchronous, like resolveRoute. Fail-static: an override naming
 * an undeclared subagent or carrying an invalid regex is SKIPPED (reported
 * via `warnings`), leaving normal classification to answer the user.
 *
 * @returns the pinned resolution, or null when nothing matched.
 */
export function matchRouteOverride(
  messageText: string,
  config: SyndicateYamlConfig & { dispatch: DispatchConfig },
  warnings?: string[],
): RouteResolution | null {
  const overrides = config.dispatch.route_overrides || [];
  if (!overrides.length || !messageText) return null;
  const subagents = config.subagents || [];

  for (const override of overrides) {
    const matched = matchSubagent(override.route ?? '', subagents);
    if (!matched) {
      warnings?.push(`route_overrides: '${override.route}' is not a declared subagent — rule skipped`);
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(override.pattern, override.flags ?? 'i');
    } catch {
      warnings?.push(`route_overrides: invalid pattern for '${override.route}' — rule skipped`);
      continue;
    }
    if (!re.test(messageText)) continue;
    return {
      route: matched.name,
      reason: (override.reason || '').trim(),
      fellBack: false,
      fallbackReason: '',
      viaOverride: true,
    };
  }
  return null;
}
