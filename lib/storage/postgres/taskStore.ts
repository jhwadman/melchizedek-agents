/**
 * lib/storage/postgres/taskStore.ts — the A2A SDK's TaskStore on Postgres.
 *
 * Tasks outlive the process that started them and are visible to every
 * instance, so a client that polls a different replica, or polls after a
 * restart, still finds its task. Each task is filed under the tenant and
 * owner the SDK's own scoping rule derives from the call context (the
 * default resolver reads the authenticated user name), so one caller cannot
 * load or list another's task. `list` mirrors the SDK's InMemoryTaskStore:
 * same filters, same newest-first order, same page-token format.
 */

import type { Pool } from 'pg';
import { resolveUserScope } from '@a2a-js/sdk/server';
import type { TaskStore } from '@a2a-js/sdk/server';

type Task = Parameters<TaskStore['save']>[0];
type Context = Parameters<TaskStore['save']>[1];
type ListParams = Parameters<TaskStore['list']>[0];
type ListResult = Awaited<ReturnType<TaskStore['list']>>;

const DEFAULT_PAGE_SIZE = 50;

export interface PostgresTaskStoreOptions {
  /** Owner of a call. Default: the SDK's resolveUserScope (the authenticated user name). */
  ownerResolver?: (context: Context) => string;
  /** Days a task is kept after its last update (expire_at). Default 7. */
  ttlDays?: number;
}

function encodePageToken(timestamp: string, id: string): string {
  return Buffer.from(`${timestamp}|${id}`).toString('base64');
}

function decodePageToken(token: string): { timestamp: string; id: string } {
  const [timestamp, ...idParts] = Buffer.from(token, 'base64').toString('utf-8').split('|');
  if (idParts.length === 0) throw new Error('Invalid page token format.');
  return { timestamp, id: idParts.join('|') };
}

export class PostgresTaskStore implements TaskStore {
  private readonly owner: (context: Context) => string;
  private readonly ttlMs: number;
  private readonly pool: Pool;
  private readonly agentId: string;

  constructor(pool: Pool, agentId: string, options: PostgresTaskStoreOptions = {}) {
    this.pool = pool;
    this.agentId = agentId;
    this.owner = options.ownerResolver ?? (resolveUserScope as (c: Context) => string);
    this.ttlMs = (options.ttlDays ?? 7) * 24 * 60 * 60 * 1000;
  }

  private scope(context: Context): [string, string] {
    return [(context as { tenant?: string }).tenant ?? '', this.owner(context)];
  }

  async save(task: Task, context: Context): Promise<void> {
    const [tenant, owner] = this.scope(context);
    const t = task as { id: string; contextId?: string; status?: { state?: number; timestamp?: string } };
    await this.pool.query(
      `INSERT INTO adk_a2a_tasks (tenant, owner, agent_id, id, context_id, state, status_ts, task, updated_at, expire_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, now(), $9)
       ON CONFLICT (tenant, owner, agent_id, id) DO UPDATE
         SET context_id = EXCLUDED.context_id, state = EXCLUDED.state, status_ts = EXCLUDED.status_ts,
             task = EXCLUDED.task, updated_at = now(), expire_at = EXCLUDED.expire_at`,
      [
        tenant,
        owner,
        this.agentId,
        t.id,
        t.contextId ?? null,
        t.status?.state ?? null,
        t.status?.timestamp ?? '',
        JSON.stringify(task),
        new Date(Date.now() + this.ttlMs).toISOString(),
      ],
    );
  }

  async load(taskId: string, context: Context): Promise<Task | undefined> {
    const [tenant, owner] = this.scope(context);
    const r = await this.pool.query(
      'SELECT task FROM adk_a2a_tasks WHERE tenant = $1 AND owner = $2 AND agent_id = $3 AND id = $4',
      [tenant, owner, this.agentId, taskId],
    );
    return r.rowCount ? (r.rows[0].task as Task) : undefined;
  }

  async list(params: ListParams, context: Context): Promise<ListResult> {
    const [tenant, owner] = this.scope(context);
    const p = params as {
      contextId?: string;
      status?: number;
      pageSize?: number;
      pageToken?: string;
      statusTimestampAfter?: string;
      includeArtifacts?: boolean;
    };
    const pageSize = p.pageSize || DEFAULT_PAGE_SIZE;
    const args: unknown[] = [tenant, owner, this.agentId];
    let where = 'tenant = $1 AND owner = $2 AND agent_id = $3';
    if (p.contextId) {
      args.push(p.contextId);
      where += ` AND context_id = $${args.length}`;
    }
    if (p.status !== undefined && p.status !== 0) {
      args.push(p.status);
      where += ` AND state = $${args.length}`;
    }
    if (p.statusTimestampAfter) {
      args.push(new Date(p.statusTimestampAfter).toISOString());
      where += ` AND status_ts <> '' AND status_ts::timestamptz > $${args.length}::timestamptz`;
    }
    const total = await this.pool.query(`SELECT count(*)::int AS n FROM adk_a2a_tasks WHERE ${where}`, args);

    let cursor = '';
    if (p.pageToken) {
      const c = decodePageToken(p.pageToken);
      args.push(c.timestamp, c.id);
      cursor = ` AND (status_ts, id) < ($${args.length - 1}, $${args.length})`;
    }
    args.push(pageSize + 1);
    const rows = await this.pool.query(
      `SELECT task, status_ts, id FROM adk_a2a_tasks WHERE ${where}${cursor}
        ORDER BY status_ts DESC, id DESC LIMIT $${args.length}`,
      args,
    );
    const page = rows.rows.slice(0, pageSize);
    const tasks = page.map((row) => {
      const task = row.task as Task & { artifacts?: unknown[] };
      if (!p.includeArtifacts) task.artifacts = [];
      return task as Task;
    });
    const last = page[page.length - 1];
    return {
      tasks,
      nextPageToken: rows.rows.length > pageSize && last ? encodePageToken(last.status_ts ?? '', last.id) : '',
      pageSize,
      totalSize: total.rows[0].n,
    } as ListResult;
  }
}
