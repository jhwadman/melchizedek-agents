#!/usr/bin/env node
/**
 * scripts/a2a_server.ts — the `melchizedek-serve` bin and `npm run start:a2a`.
 *
 * Reads the environment, refuses unsafe configurations, builds the server
 * with `createA2AApp` (lib/a2a/app.ts — mountable in your own Express app),
 * listens, and drains in-flight tasks on SIGTERM. Every turn runs through
 * lib/runtime/syndicateTurn.ts, the same runtime the REPL and evals use.
 *
 * Environment (all optional; see .env.example):
 *   PORT                      listen port (4000)
 *   HOST                      bind address. Default: all interfaces when a
 *                             secret is set, 127.0.0.1 when none is.
 *   PUBLIC_URL                external base URL for agent cards; also marks a
 *                             deployment as public (secret + hardening required)
 *   A2A_SERVER_SECRET         bearer secret every request must present
 *   ALLOW_UNAUTHENTICATED     "true" to bind a non-loopback HOST with no secret
 *   ALLOW_UNHARDENED_DB       "true" to accept an unhardened Supabase schema
 *   A2A_TASK_TIMEOUT_MS       per-task wall-clock budget (900000; 0 = none)
 *   A2A_MAX_CONCURRENT_TASKS  concurrent tasks across all agents (0 = unlimited)
 *   A2A_RATE_LIMIT_MAX        task submissions per window per IP (60)
 *   A2A_RATE_LIMIT_WINDOW_MS  rate-limit window (900000)
 *   A2A_AUTH_FAILURE_MAX      failed authentications per window per IP (30)
 *   A2A_TRUST_PROXY           Express trust-proxy: hop count, true/false, or subnets (1)
 *   A2A_BODY_LIMIT            JSON body limit ("1mb")
 *   A2A_KEY_MODE              server (default): models run on the server's keys and
 *                             data is scoped by X-User-Id; byok: the caller's
 *                             X-API-Key pays and its hash scopes the data (the
 *                             pre-0.16 behaviour — see the boot warning)
 *   A2A_SERVED_AGENTS         comma list: the only agent ids /:agentId/ serves;
 *                             only these may fall back to examples/ and templates/
 *   A2A_REGISTRY_AGENTS       comma list: bare ids that load from adk_agent_registry
 *                             (others are files; registry:<id> always is the registry)
 *   A2A_SHUTDOWN_GRACE_MS     how long SIGTERM waits for running tasks (25000)
 *   DATABASE_URL              Postgres for every durable store (sessions, memory,
 *                             A2A tasks, erase) — multi-instance safe (ADR 0021).
 *                             Without it: Supabase when its credentials are set,
 *                             else process memory.
 */
import { realpathSync } from 'node:fs';
import type { Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { setLogLevel, LogLevel } from '@google/adk';

import { createA2AApp } from '../lib/a2a/app.ts';
import { postgresStorage } from '../lib/storage/postgres/index.ts';
import { isPlaceholderValue, loadEnv } from '../lib/loadEnv.ts';
import { flushTracing } from '../lib/observability/tracer.ts';

// Re-exported for existing importers (tests/failNarration.test.ts).
export { describeTurnError } from '../lib/a2a/executor.ts';

/** Minimum bearer-secret length below which the server warns. */
const MIN_SECRET_LENGTH = 32;

const isLoopback = (host: string) => host === '127.0.0.1' || host === '::1' || host === 'localhost';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number (got '${raw}')`);
  return Math.floor(n);
}

function envTrustProxy(): number | boolean | string {
  const raw = process.env.A2A_TRUST_PROXY?.trim();
  if (!raw) return 1;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return raw;
}

function fatal(message: string): never {
  console.error(`[A2A] ✗ FATAL: ${message}`);
  process.exit(1);
}

export async function startServer(syndicateName: string = 'syndicate.yaml'): Promise<Server> {
  loadEnv(import.meta.url);
  // Conversation content stays out of stdout unless the operator opts in:
  // the root span carries the full user message and answer.
  if (process.env.OTEL_CONSOLE_SPANS === undefined) process.env.OTEL_CONSOLE_SPANS = 'false';
  // ADK's INFO/DEBUG logs carry raw event JSON; keep them quiet.
  setLogLevel(LogLevel.WARN);

  const publicUrl = process.env.PUBLIC_URL?.trim() || undefined;
  const port = envInt('PORT', 4000);

  // ── Authentication posture ─────────────────────────────────────────────────
  let secret = process.env.A2A_SERVER_SECRET?.trim() || undefined;
  if (secret && isPlaceholderValue(secret)) {
    fatal('A2A_SERVER_SECRET is still the .env.example placeholder. Generate one: openssl rand -hex 32');
  }
  if (secret && secret.length < MIN_SECRET_LENGTH) {
    console.warn(`[A2A] ⚠ A2A_SERVER_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; use a long random value.`);
  }
  let host = process.env.HOST?.trim() || undefined;
  if (!secret) {
    if (publicUrl) fatal('PUBLIC_URL is set but A2A_SERVER_SECRET is missing. Refusing to start an unauthenticated public server.');
    if (host && !isLoopback(host) && process.env.ALLOW_UNAUTHENTICATED !== 'true') {
      fatal(`HOST=${host} would expose an unauthenticated server. Set A2A_SERVER_SECRET, or ALLOW_UNAUTHENTICATED=true to accept the risk.`);
    }
    // Without a secret the server answers only on this machine.
    host = host ?? '127.0.0.1';
    console.warn(`[A2A] ⚠ A2A_SERVER_SECRET is not set: authentication is off and the server binds ${host} only.`);
  }

  const list = (name: string) =>
    process.env[name] ? process.env[name]!.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  const servedAgents = list('A2A_SERVED_AGENTS');
  const registryAgents = list('A2A_REGISTRY_AGENTS');
  const keyModeRaw = (process.env.A2A_KEY_MODE ?? 'server').trim().toLowerCase();
  if (keyModeRaw !== 'server' && keyModeRaw !== 'byok') fatal(`A2A_KEY_MODE must be 'server' or 'byok' (got '${keyModeRaw}')`);
  const keyMode = keyModeRaw as 'server' | 'byok';

  // Storage: Postgres when DATABASE_URL is set (every durable store, safe
  // across instances); otherwise createA2AApp's default (Supabase, else memory).
  const databaseUrl = process.env.DATABASE_URL?.trim() || undefined;
  const pgStorage = databaseUrl
    ? postgresStorage({
        connectionString: databaseUrl,
        memory: { apiKey: process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || '' },
      })
    : undefined;

  let built;
  try {
    built = await createA2AApp({
      defaultSyndicate: syndicateName,
      publicUrl,
      port,
      serverSecret: secret,
      requireHardenedDb: !!publicUrl && process.env.ALLOW_UNHARDENED_DB !== 'true',
      taskTimeoutMs: envInt('A2A_TASK_TIMEOUT_MS', 15 * 60 * 1000),
      maxConcurrentTasks: envInt('A2A_MAX_CONCURRENT_TASKS', 0),
      rateLimit: { windowMs: envInt('A2A_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000), max: envInt('A2A_RATE_LIMIT_MAX', 60) },
      authFailureLimit: { windowMs: 15 * 60 * 1000, max: envInt('A2A_AUTH_FAILURE_MAX', 30) },
      trustProxy: envTrustProxy(),
      bodyLimit: process.env.A2A_BODY_LIMIT?.trim() || '1mb',
      servedAgents,
      registryAgents,
      keyMode,
      ...(pgStorage ? { storage: pgStorage } : {}),
    });
  } catch (err: unknown) {
    if ((err as any)?.code === 'ENOENT') throw err;
    fatal(err instanceof Error ? err.message : String(err));
  }
  const authMode = `${secret ? 'bearer secret' : 'no secret (loopback only)'}; keys: ${keyMode === 'byok' ? "caller's X-API-Key (byok)" : "server's own"}`;
  // The secret is not needed past this point; drop the reference.
  secret = undefined;

  const { app, config, sessionBackend, shutdown } = built;
  const server: Server = await new Promise((resolve) => {
    const s = host ? app.listen(port, host, () => resolve(s)) : app.listen(port, () => resolve(s));
  });
  // Load balancers commonly hold idle connections for 60 s; Node's default
  // keep-alive of 5 s makes them reuse a socket Node has just closed (502s).
  server.keepAliveTimeout = envInt('A2A_KEEP_ALIVE_TIMEOUT_MS', 65_000);
  server.headersTimeout = server.keepAliveTimeout + 1_000;

  const base = publicUrl ?? `http://${host && host !== '0.0.0.0' ? host : 'localhost'}:${port}`;
  console.log(`[A2A] ✓ Serving '${config.syndicate_name}' on ${host ?? '0.0.0.0'}:${port}`);
  console.log(`[A2A]   card     ${base}/.well-known/agent-card.json`);
  console.log(`[A2A]   jsonrpc  ${base}/a2a/jsonrpc   rest ${base}/a2a/rest`);
  console.log(`[A2A]   auth     ${authMode}`);
  console.log(`[A2A]   storage  ${pgStorage ? 'postgres (multi-instance safe)' : sessionBackend === 'durable' ? 'supabase (tasks are per process: one replica)' : 'in-memory (lost on restart; one replica)'}`);
  console.log(`[A2A]   agents   ${servedAgents ? servedAgents.join(', ') : 'the default, plus any file in the agents directory at /:agentId/ (A2A_SERVED_AGENTS restricts)'}`);
  if (registryAgents) console.log(`[A2A]   registry ${registryAgents.join(', ')} (bare ids loaded from adk_agent_registry)`);
  if (keyMode === 'server' && sessionBackend === 'durable') {
    console.warn('[A2A] ⚠ Key mode is "server": sessions and memory are scoped by X-User-Id (else "default").');
    console.warn('[A2A]   Data written by earlier versions lives under key-hash silos (a2a-<hash>/…) that');
    console.warn('[A2A]   only A2A_KEY_MODE=byok reaches. Keep byok until that data is migrated.');
  }
  console.log(`[A2A]   health   ${base}/healthz  ${base}/readyz`);

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  let stopping = false;
  const graceMs = envInt('A2A_SHUTDOWN_GRACE_MS', 25_000);
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[A2A] ${signal}: draining — no new tasks; waiting up to ${graceMs} ms for running ones.`);
    server.close();
    const canceled = await shutdown(graceMs);
    if (canceled > 0) console.warn(`[A2A] ⚠ ${canceled} task(s) did not finish in time and were canceled.`);
    // Give canceled tasks a moment to publish their final status, then flush
    // telemetry so the last turns reach the ledger, then release the pool.
    await new Promise((r) => setTimeout(r, canceled > 0 ? 500 : 0));
    await flushTracing().catch(() => {});
    await pgStorage?.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    console.error(`[A2A] ⚠ Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });

  return server;
}

// Run-as-main guard. Compare against the REALPATH of argv[1]: through the
// npm bin, argv[1] is the .bin symlink while import.meta.url is the resolved
// file, so a naive compare never matches (the 0.9.0 bin bug).
const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return import.meta.url === `file://${process.argv[1]}`;
  }
})();

if (invokedAsMain) {
  const arg = process.argv[2];
  if (arg === '--help' || arg === '-h') {
    console.log('Usage: melchizedek-serve [<syndicate>.yaml | registry:<id>]\n\nServes a syndicate over A2A. Environment variables are listed at the top of scripts/a2a_server.ts and in .env.example.');
    process.exit(0);
  }
  startServer(arg || 'syndicate.yaml').catch((error) => {
    if (error?.code === 'ENOENT') {
      console.error(
        `[A2A] Syndicate not found: ${arg || 'syndicate.yaml'}.\n`
        + '      Pass your syndicate: melchizedek-serve <name>.yaml\n'
        + '      (agents directory: MELCHIZEDEK_AGENTS_DIR, or <cwd>/config/agents)',
      );
      process.exit(1);
    }
    console.error(error);
    process.exit(1);
  });
}
