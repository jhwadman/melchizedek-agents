/**
 * Cross-agent transcript sharing.
 *
 * ── The problem this solves ───────────────────────────────────────────────
 * Under plan-dispatch every route runs as its OWN root agent (XScout,
 * Conversationalist, FinancialAnalyst) against ONE shared session. Sharing
 * the session is necessary but not sufficient: ADK decides how a stored
 * event is rendered into a prompt by comparing `event.author` against the
 * agent that is running, and every prior event fails that comparison the
 * moment the route changes. `convertForeignEvent` then rewrites each one to
 * `role: "user"` prefixed with "For context:".
 *
 * Replaying a real production session — a four-turn thread that had passed
 * through three routes — through ADK's own content processor showed what the
 * last route actually received: 15 contents, 118,013 bytes, and EVERY ONE of them
 * `role: "user"`. Not a single `role: "model"` turn in the prompt. The
 * history was all there — and unreadable as a conversation, because nothing
 * in it was marked as having been said by the desk. That is the "it doesn't
 * know what I'm referring to" failure, and no amount of session sharing
 * fixes it, because sharing was never the broken part.
 *
 * Two further leaks rode along in the same conversion. `convertForeignEvent`
 * clones any part it does not recognise verbatim, so the previous route's
 * private chain-of-thought ("**My Micron Monday Decision Strategy** Okay, so
 * the question is…", `thought: true`) arrived as USER speech. And raw tool
 * payloads were inlined as text — one `load_memory` result alone was 23,502
 * characters, one `get_company_fundamentals` 8,953 — all of it handed to a
 * 400-character, tool-less flash-lite route that could do nothing with it.
 *
 * ── The fix ───────────────────────────────────────────────────────────────
 * Project the stored transcript before ADK ever sees it: rewrite each past
 * agent turn to the CURRENT agent's name so it survives as a real
 * `role: "model"` turn, label it with the desk that spoke, and drop what no
 * successor can use — thoughts, tool calls, tool results.
 *
 * The projection is a READ-TIME view. The stored session keeps everything,
 * verbatim, because long-term memory ingestion reads the real record.
 */

import { BaseSessionService } from '@google/adk';
import type {
  CreateSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  DeleteSessionRequest,
  Session,
  Event,
} from '@google/adk';

/** Tuning for {@link projectTranscript}. Defaults are the production values. */
export interface ProjectionOptions {
  /**
   * Character budget for the projected HISTORY, walked backwards from the
   * newest event. Older events are dropped whole once it is exhausted.
   *
   * A bound is required — the session row is a 7-day append-only log and a
   * busy channel reaches six figures of text — but it is set generously:
   * 40,000 characters of tool-free, thought-free prose is many turns, and
   * the analyst route recovers older material through long-term memory.
   */
  maxHistoryChars?: number;
  /** Longest single past turn kept intact; the tail is elided. */
  maxTurnChars?: number;
}

const DEFAULT_MAX_HISTORY_CHARS = 40_000;
const DEFAULT_MAX_TURN_CHARS = 4_000;

/**
 * The text a successor can actually read: spoken output only.
 *
 * Excluded, deliberately:
 *  - `thought: true` parts — another agent's reasoning is not conversation,
 *    and ADK's own foreign-event conversion leaks it as user speech.
 *  - function calls and their results — the successor cannot re-enter that
 *    tool loop, and the payloads dwarf the answers they produced.
 *  - `toolCall` / `toolResponse` parts (the camelCase shape some providers
 *    emit) — invisible to ADK's `part.functionCall` checks, so they survive
 *    its conversion untouched and arrive as empty noise.
 */
function spokenText(event: Event): string {
  const parts = (event.content?.parts ?? []) as Array<Record<string, unknown>>;
  return parts
    .filter(p => !p.thought && !p.functionCall && !p.functionResponse && !p.toolCall && !p.toolResponse)
    .map(p => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function elide(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[…turn truncated]`;
}

/**
 * Render a stored transcript as history the given agent can read.
 *
 * User events pass through untouched. Every agent event becomes a
 * `role: "model"` turn ATTRIBUTED to `forAgent`, which is what keeps ADK
 * from rewriting it into "For context:" user text — with the original
 * author kept as a visible `[Name]` label when it was a different desk, so
 * attribution survives without costing the turn structure.
 *
 * Events that said nothing out loud (a pure tool call, a pure tool result)
 * disappear entirely. Calls and their responses are dropped together, so
 * ADK's function-response pairing never sees a widowed half.
 *
 * Pure and synchronous — see tests/transcript.test.ts.
 */
export function projectTranscript(
  events: Event[],
  forAgent: string,
  options: ProjectionOptions = {},
): Event[] {
  const maxHistory = options.maxHistoryChars ?? DEFAULT_MAX_HISTORY_CHARS;
  const maxTurn = options.maxTurnChars ?? DEFAULT_MAX_TURN_CHARS;

  const kept: Event[] = [];
  let budget = maxHistory;

  // Backwards: when the budget runs out it is the OLDEST context that goes.
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];

    if (event.author === 'user') {
      const text = spokenText(event);
      if (!text) continue;
      budget -= text.length;
      kept.push(event);
      if (budget <= 0) break;
      continue;
    }

    const text = spokenText(event);
    if (!text) continue;

    const label = event.author && event.author !== forAgent ? `[${event.author}] ` : '';
    const body = `${label}${elide(text, maxTurn)}`;
    budget -= body.length;
    kept.push({
      ...event,
      author: forAgent,
      content: { role: 'model', parts: [{ text: body }] },
    } as Event);
    if (budget <= 0) break;
  }

  return kept.reverse();
}

/**
 * A compact plain-text digest of the exchange, for an agent that must be
 * given history as INPUT rather than as conversation.
 *
 * The dispatch classifier is that agent. It runs in its own lane so its JSON
 * verdicts never pollute the user-facing transcript — and the cost of that
 * isolation, in production, was a router that had never seen a single answer
 * it routed. On 2026-08-15 its lane held four user messages and four of its
 * own verdicts, nothing else; a user's counter-argument to the desk's
 * MU/SNDK/NVDA/AMD call therefore read as a remark with no request behind
 * it, and went to small talk. Its own rules ("follow-ups on prior analysis →
 * FinancialAnalyst") were unusable, because no prior analysis was in view.
 *
 * @param maxTurns        newest N exchanges to show
 * @param maxCharsPerTurn per-line budget — the router classifies, it does not
 *                        read; the shape of an answer is enough
 */
export function renderTranscriptDigest(
  events: Event[],
  { maxTurns = 8, maxCharsPerTurn = 400 }: { maxTurns?: number; maxCharsPerTurn?: number } = {},
): string {
  const lines: string[] = [];

  for (let i = events.length - 1; i >= 0 && lines.length < maxTurns; i--) {
    const event = events[i];
    const text = spokenText(event);
    if (!text) continue;
    // The per-message date marker is harness plumbing, not conversation, and
    // it would consume a quarter of every line's budget.
    const clean = text.replace(/^\[System Context:[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!clean) continue;
    const speaker = event.author === 'user' ? 'user' : event.author || 'desk';
    lines.push(`${speaker}: ${clean.length > maxCharsPerTurn ? `${clean.slice(0, maxCharsPerTurn)}…` : clean}`);
  }

  return lines.reverse().join('\n');
}

/**
 * A read-time projection over another session service.
 *
 * `getSession` returns the transcript as {@link projectTranscript} renders it
 * for one named agent; every write goes to the REAL session held underneath,
 * so the durable record keeps thoughts, tool calls and full payloads for
 * long-term memory ingestion and for operators reading the row.
 *
 * Both views are kept live during a turn: the runner appends to the
 * projected session it is holding (it re-reads `session.events` before every
 * model call, so the agent's own in-flight tool calls must stay visible and
 * unprojected), while the same event is appended and persisted to the real
 * one. Only history is projected; the current turn never is.
 *
 * Construct one per turn — it is bound to a single agent name.
 */
export class ProjectedSessionService extends BaseSessionService {
  private readonly inner: BaseSessionService;
  private readonly forAgent: string;
  private readonly options: ProjectionOptions;
  /** Real sessions handed out by `getSession`, keyed by identity. */
  private readonly stored = new Map<string, Session>();

  constructor(inner: BaseSessionService, forAgent: string, options: ProjectionOptions = {}) {
    super();
    this.inner = inner;
    this.forAgent = forAgent;
    this.options = options;
  }

  private key(appName: string, userId: string, sessionId: string): string {
    return `${appName}:${userId}:${sessionId}`;
  }

  async createSession(request: CreateSessionRequest): Promise<Session> {
    return this.inner.createSession(request);
  }

  async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    return this.inner.listSessions(request);
  }

  async deleteSession(request: DeleteSessionRequest): Promise<void> {
    this.stored.delete(this.key(request.appName, request.userId, request.sessionId));
    return this.inner.deleteSession(request);
  }

  async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    const real = await this.inner.getSession(request);
    if (!real) return undefined;
    this.stored.set(this.key(request.appName, request.userId, request.sessionId), real);
    return {
      ...real,
      events: projectTranscript(real.events, this.forAgent, this.options),
    };
  }

  async appendEvent(request: { session: Session; event: Event }): Promise<Event> {
    const { session, event } = request;
    if (event.partial) return event;

    // The runner's view (projected) — base class merges state deltas.
    await super.appendEvent({ session, event });

    // The durable record (real), persisted by the wrapped service.
    const real = this.stored.get(this.key(session.appName, session.userId, session.id));
    await this.inner.appendEvent({ session: real && real !== session ? real : session, event });

    return event;
  }
}
