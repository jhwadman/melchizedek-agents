/**
 * lib/storage/postgres/sessionService.ts — ADK sessions on a direct Postgres
 * connection (ADR 0021).
 *
 * WHY it differs from the Supabase session service:
 *   That one re-uploads a conversation's WHOLE events array on every event.
 *   Two turns on one conversation each hold a private copy, and whichever
 *   writes last erases the other's events; the bytes written grow with the
 *   square of the conversation's length. Here each event is one row in
 *   adk_session_events, appended under a row lock on its session, and state
 *   changes are merged into the stored state rather than overwriting it.
 *
 *   Events are stored as ADK produced them. The Supabase service trims thought
 *   signatures and large tool payloads because it rewrites everything on every
 *   event; appending each event once removes that cost, and a DELEGATE
 *   conversation that is replayed to the model gets back exactly what it sent.
 *
 * Rows share adk_sessions with the Supabase service (same id scheme:
 * '<appName>:<userId>:<sessionId>'), so erase and the session prune cover
 * both. Tables: db/migrations/0001_base.sql and 0003_postgres_storage.sql.
 */

import { randomUUID } from 'node:crypto';

import { BaseSessionService, createSession } from '@google/adk';
import type {
  CreateSessionRequest,
  DeleteSessionRequest,
  Event,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  Session,
} from '@google/adk';
import type { Pool, PoolClient } from 'pg';

export interface PostgresSessionOptions {
  /** Days a conversation is kept after its last event (expire_at). Default 7. */
  ttlDays?: number;
}

function dbId(appName: string, userId: string, sessionId: string): string {
  return `${appName}:${userId}:${sessionId}`;
}

/** The persisted part of a state delta: ADK never stores `temp:` keys. */
export function persistedDelta(delta: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(delta ?? {})) {
    if (!k.startsWith('temp:')) out[k] = v;
  }
  return out;
}

export class PostgresSessionService extends BaseSessionService {
  private readonly ttlMs: number;
  private readonly pool: Pool;

  constructor(pool: Pool, options: PostgresSessionOptions = {}) {
    super();
    this.pool = pool;
    this.ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
  }

  private expireAt(): string {
    return new Date(Date.now() + this.ttlMs).toISOString();
  }

  async createSession(request: CreateSessionRequest): Promise<Session> {
    const sessionId = request.sessionId || randomUUID();
    const id = dbId(request.appName, request.userId, sessionId);
    const now = Date.now();
    // A concurrent create for the same id keeps the row that is already
    // there, events and all, instead of resetting it.
    const inserted = await this.pool.query(
      `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time, expire_at)
       VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb, $5, $6)
       ON CONFLICT (id) DO NOTHING`,
      [id, request.appName, request.userId, JSON.stringify(request.state ?? {}), now, this.expireAt()],
    );
    if (inserted.rowCount === 0) {
      const existing = await this.getSession({ appName: request.appName, userId: request.userId, sessionId });
      if (existing) return existing;
    }
    return createSession({
      id: sessionId,
      appName: request.appName,
      userId: request.userId,
      state: request.state ?? {},
      events: [],
      lastUpdateTime: now,
    });
  }

  async getSession(request: GetSessionRequest): Promise<Session | undefined> {
    const id = dbId(request.appName, request.userId, request.sessionId);
    const row = await this.pool.query(
      'SELECT app_name, user_id, state, last_update_time FROM adk_sessions WHERE id = $1',
      [id],
    );
    if (row.rowCount === 0) return undefined;

    const cfg = request.config ?? {};
    const params: unknown[] = [id];
    let where = 'session_id = $1';
    if (cfg.afterTimestamp) {
      params.push(cfg.afterTimestamp);
      where += ` AND ts > $${params.length}`;
    }
    // The newest N, returned oldest first.
    const events = cfg.numRecentEvents
      ? await this.pool.query(
          `SELECT event FROM (SELECT event, seq FROM adk_session_events WHERE ${where} ORDER BY seq DESC LIMIT ${Math.max(0, Math.floor(cfg.numRecentEvents))}) recent ORDER BY seq ASC`,
          params,
        )
      : await this.pool.query(`SELECT event FROM adk_session_events WHERE ${where} ORDER BY seq ASC`, params);

    const r = row.rows[0];
    return {
      id: request.sessionId,
      appName: r.app_name,
      userId: r.user_id,
      state: r.state ?? {},
      events: events.rows.map((e) => e.event as Event),
      lastUpdateTime: Number(r.last_update_time ?? 0),
    } as Session;
  }

  /**
   * Same paging contract as the Supabase service: `limit` with `page`
   * (1-based, wins) or `offset` (0-based), optional order by last update,
   * and the real total alongside the page. Events are omitted.
   */
  async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    const { limit, order } = request;
    const offset =
      limit !== undefined && request.page !== undefined
        ? (Math.max(1, request.page) - 1) * limit
        : (request.offset ?? 0);

    const params: unknown[] = [request.appName];
    let where = 'app_name = $1';
    if (request.userId !== undefined) {
      params.push(request.userId);
      where += ` AND user_id = $${params.length}`;
    }
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM adk_sessions WHERE ${where}`, params);
    const orderBy = order ? `ORDER BY last_update_time ${order === 'asc' ? 'ASC' : 'DESC'}, id` : 'ORDER BY id';
    const window = `${limit !== undefined ? `LIMIT ${Math.max(0, Math.floor(limit))}` : ''} OFFSET ${Math.max(0, Math.floor(offset))}`;
    const rows = await this.pool.query(
      `SELECT id, app_name, user_id, state, last_update_time FROM adk_sessions WHERE ${where} ${orderBy} ${window}`,
      params,
    );

    const sessions = rows.rows.map(
      (row) =>
        ({
          id: String(row.id).slice(String(row.app_name).length + String(row.user_id).length + 2),
          appName: row.app_name,
          userId: row.user_id,
          state: row.state ?? {},
          events: [],
          lastUpdateTime: Number(row.last_update_time ?? 0),
        }) as Session,
    );
    const totalItems = total.rows[0].n as number;
    return {
      sessions,
      page: limit ? Math.floor(offset / limit) + 1 : 1,
      limit: limit ?? totalItems,
      totalItems,
      totalPages: limit ? Math.max(1, Math.ceil(totalItems / limit)) : 1,
    };
  }

  async deleteSession(request: DeleteSessionRequest): Promise<void> {
    // Events go with it (ON DELETE CASCADE).
    await this.pool.query('DELETE FROM adk_sessions WHERE id = $1', [
      dbId(request.appName, request.userId, request.sessionId),
    ]);
  }

  async appendEvent(request: { session: Session; event: Event }): Promise<Event> {
    const { session, event } = request;
    // Streaming fragments are appended whole once complete.
    if (event.partial) return event;

    // ADK's own merge: applies the state delta to the live session, strips
    // temp: keys, pushes the event. Must run (see the Supabase service).
    await super.appendEvent({ session, event });
    session.lastUpdateTime = Date.now();

    const id = dbId(session.appName, session.userId, session.id);
    const delta = persistedDelta(event.actions?.stateDelta as Record<string, unknown> | undefined);
    const stored = JSON.parse(JSON.stringify(event));
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // The row lock serializes appends to one conversation across every
      // process; a missing row (created elsewhere, or pruned) is recreated.
      const locked = await client.query('SELECT 1 FROM adk_sessions WHERE id = $1 FOR UPDATE', [id]);
      if (locked.rowCount === 0) {
        await client.query(
          `INSERT INTO adk_sessions (id, app_name, user_id, state, events, last_update_time, expire_at)
           VALUES ($1, $2, $3, '{}'::jsonb, '[]'::jsonb, $4, $5)
           ON CONFLICT (id) DO NOTHING`,
          [id, session.appName, session.userId, session.lastUpdateTime, this.expireAt()],
        );
        await client.query('SELECT 1 FROM adk_sessions WHERE id = $1 FOR UPDATE', [id]);
      }
      await client.query(
        `INSERT INTO adk_session_events (session_id, seq, ts, event)
         VALUES ($1, (SELECT coalesce(max(seq), 0) + 1 FROM adk_session_events WHERE session_id = $1), $2, $3::jsonb)`,
        [id, typeof event.timestamp === 'number' ? event.timestamp : null, JSON.stringify(stored)],
      );
      await client.query(
        `UPDATE adk_sessions
            SET state = coalesce(state, '{}'::jsonb) || $2::jsonb,
                last_update_time = $3,
                expire_at = $4,
                updated_at = now()
          WHERE id = $1`,
        [id, JSON.stringify(delta), session.lastUpdateTime, this.expireAt()],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Failed to append event: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      client.release();
    }
    return event;
  }
}
