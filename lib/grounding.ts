/**
 * lib/grounding.ts — pure helpers for reading native web-search grounding
 * (Gemini `groundingMetadata`) off ADK events. Grounding is a server-side
 * tool: it never appears as a function call, so without this a searched
 * answer and a recalled one are indistinguishable in logs and to clients.
 * scripts/a2a_server.ts folds these into `[A2A] ⌕ Grounding` log lines and
 * the `Invoking tool: web_search` / `Web sources: …` status lines that
 * nihilistic-penguin's RouteTrace renders into the Discord footer.
 */

export interface GroundingState {
  queries: Set<string>;
  sources: Set<string>;
}

export function newGroundingState(): GroundingState {
  return { queries: new Set(), sources: new Set() };
}

/** Domain of a grounding chunk: Gemini's `web.title` is already the bare
 *  domain (its `uri` is an opaque redirect); fall back to the URI's host. */
export function groundingDomain(chunk: any): string | null {
  const title: string | undefined = chunk?.web?.title;
  if (title && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) return title.toLowerCase();
  const uri: string | undefined = chunk?.web?.uri;
  if (uri) {
    try { return new URL(uri).hostname.replace(/^www\./, ''); } catch { /* opaque */ }
  }
  return title || null;
}

/**
 * Fold one event's groundingMetadata into `state`. Returns true when the
 * event added something new (a query or a source not seen before) — the
 * caller logs/publishes only then, so a metadata block repeated on every
 * streaming chunk produces one line, not many.
 */
export function collectGrounding(event: any, state: GroundingState): boolean {
  const gm = event?.groundingMetadata;
  if (!gm) return false;
  const before = state.queries.size + state.sources.size;
  for (const q of gm.webSearchQueries ?? []) {
    if (typeof q === 'string' && q.trim()) state.queries.add(q.trim());
  }
  for (const c of gm.groundingChunks ?? []) {
    const d = groundingDomain(c);
    if (d) state.sources.add(d);
  }
  return state.queries.size + state.sources.size > before;
}

/** The `[A2A] ⌕ Grounding: …` log line body. */
export function describeGrounding(state: GroundingState, maxSources = 8): string {
  const q = state.queries.size, s = state.sources.size;
  const list = s ? ` (${[...state.sources].slice(0, maxSources).join(', ')})` : '';
  return `${q} quer${q === 1 ? 'y' : 'ies'} · ${s} source${s === 1 ? '' : 's'}${list}`;
}

/** The consumer contract line (penguin RouteTrace `_SOURCES_RE`), or null. */
export function webSourcesLine(state: GroundingState, max = 10): string | null {
  if (!state.sources.size) return null;
  return `Web sources: ${[...state.sources].slice(0, max).join(', ')}`;
}
