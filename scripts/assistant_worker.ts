#!/usr/bin/env node
/**
 * scripts/assistant_worker.ts — runs the jobs the Assistant queues.
 *
 * WHY this file exists:
 *   The Assistant (config/agents/examples/assistant.yaml) hands long work
 *   off with `task_queue`, which only writes a record to the task store
 *   (lib/tools/taskTools.ts). Something has to run those records, and it
 *   must not be a tool: a tool that runs agents is what the tool-contract
 *   doctrine refuses. So the runner is a plain process, like a cron job or
 *   a queue consumer. It claims one queued job at a time, runs the job's
 *   instruction as a fresh single turn through ONE agent declared in YAML,
 *   and writes the result (or the error) back to the store, where
 *   `task_get` reads it in a later conversation.
 *
 *   The agent is compiled with lib/compile.ts, the same compiler the A2A
 *   server and the observatory use, so a job runs the exact agent the
 *   conversation would have called directly. Any syndicate and any
 *   subagent in it can serve as the worker.
 *
 * Usage:
 *   npm run assistant:worker                      poll every 30 s until Ctrl-C
 *   npm run assistant:worker -- --once            drain the queue, then exit (cron)
 *   npm run assistant:worker -- --interval 10     poll every 10 s
 *   npm run assistant:worker -- --syndicate assistant --agent Worker   (the defaults)
 *
 *   --agent names a subagent of the syndicate, or its orchestrator.
 *   MELCHIZEDEK_TASKS_FILE moves the store (default: outputs/tasks.json),
 *   and must match the chat process's value. Run ONE worker per store.
 */

import { randomUUID } from 'node:crypto';
import { InMemorySessionService, LogLevel, Runner, setLogLevel } from '@google/adk';
import type { LlmAgent } from '@google/adk';

import { compileGraph, compileSubagent } from '../lib/compile.ts';
import { loadEnv } from '../lib/loadEnv.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import {
  PROVIDERS,
  providerForModel,
  providerKeyPresent,
  registerAvailableProviders,
} from '../lib/models/registry.ts';
import {
  claimNextJob,
  finishJob,
  recoverInterruptedJobs,
  taskStorePath,
} from '../lib/tools/taskTools.ts';
import type { TaskRecord } from '../lib/tools/taskTools.ts';

loadEnv(import.meta.url);
setLogLevel(LogLevel.WARN);
registerAvailableProviders();

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
};
const syndicateArg = flag('syndicate') ?? 'assistant';
const syndicateFile = syndicateArg.endsWith('.yaml') ? syndicateArg : `${syndicateArg}.yaml`;
const agentName = flag('agent') ?? 'Worker';
const once = argv.includes('--once');
const intervalSeconds = Math.max(5, Number(flag('interval') ?? 30) || 30);
/** A job still running after this long is recorded as failed. */
const JOB_TIMEOUT_MS = 10 * 60 * 1000;
/** Set by Ctrl-C: finish the job in hand, claim no more. */
let stopping = false;

// ── The worker agent ─────────────────────────────────────────────────────────
const config = loadSyndicate(syndicateFile);
const sub = config.subagents.find((s) => s.name === agentName);
const isOrchestrator = config.orchestrator.name === agentName;
if (!sub && !isOrchestrator) {
  const names = [config.orchestrator.name, ...config.subagents.map((s) => s.name)].join(', ');
  console.error(`✗ ${syndicateFile} has no agent named "${agentName}". Agents: ${names}.`);
  process.exit(1);
}

// Fail fast with the missing variable's NAME, as the chat CLI does.
const model = sub ? sub.model : config.orchestrator.model;
const provider = providerForModel(model ?? '');
if (!providerKeyPresent(provider)) {
  console.error(`✗ ${PROVIDERS[provider].label} requires ${PROVIDERS[provider].keyEnv}, which is not set.`);
  process.exit(1);
}

const log = (message: string) => console.log(`[worker] ${message}`);
const agent: LlmAgent = sub
  ? await compileSubagent(sub, { log, onUnknownTool: (n) => log(`unknown tool '${n}' skipped`) })
  : await compileGraph(config, { log, onUnknownTool: (n) => log(`unknown tool '${n}' skipped`) });

// ── One job = one fresh single-turn session ─────────────────────────────────
async function runJob(job: TaskRecord): Promise<string> {
  const appName = 'assistant-worker';
  const sessionService = new InMemorySessionService();
  const runner = new Runner({ agent, appName, sessionService });
  const session = await sessionService.createSession({
    appName,
    userId: 'local-user',
    sessionId: randomUUID(),
  });

  let text = '';
  let failure = '';
  for await (const event of runner.runAsync({
    userId: 'local-user',
    sessionId: session.id,
    newMessage: { role: 'user', parts: [{ text: job.instruction ?? job.title }] },
  })) {
    // An LlmResponse can carry an error without throwing; keep it.
    const ev = event as any;
    if ((ev.errorCode || ev.errorMessage) && ev.errorCode !== 'STOP') {
      failure = `${ev.errorCode ?? 'ERROR'}: ${ev.errorMessage ?? ''}`.trim();
    }
    // Only the worker's own final text is the result: skip thoughts and
    // anything a nested agent said on the way.
    if (ev.author && ev.author !== agent.name) continue;
    for (const part of event.content?.parts ?? []) {
      if (part.text && !(part as any).thought) text += part.text;
    }
  }
  if (!text.trim()) throw new Error(failure || 'the agent returned no text');
  return text.trim();
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 60_000} minutes`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** Runs queued jobs until none is left. Returns how many it ran. */
async function drain(): Promise<number> {
  let ran = 0;
  for (let job = claimNextJob(); job; job = stopping ? null : claimNextJob()) {
    ran += 1;
    const started = Date.now();
    log(`${job.id} started: ${job.title}`);
    try {
      const result = await withTimeout(runJob(job), JOB_TIMEOUT_MS);
      finishJob(job.id, { result });
      log(`${job.id} done in ${Math.round((Date.now() - started) / 1000)} s`);
    } catch (error: any) {
      finishJob(job.id, { error: String(error?.message ?? error) });
      log(`${job.id} failed: ${error?.message ?? error}`);
    }
  }
  return ran;
}

// ── Main ─────────────────────────────────────────────────────────────────────
log(`agent ${agentName} (${model ?? 'ADK default'}) from ${syndicateFile}`);
log(`store ${taskStorePath()}`);
const { requeued, failed } = recoverInterruptedJobs();
if (requeued.length) log(`re-queued interrupted jobs: ${requeued.join(', ')}`);
if (failed.length) log(`gave up on repeatedly interrupted jobs: ${failed.join(', ')}`);

if (once) {
  const ran = await drain();
  log(ran ? `queue empty after ${ran} job(s)` : 'queue empty');
  process.exit(0);
}

log(`polling every ${intervalSeconds} s (Ctrl-C to stop)`);
process.on('SIGINT', () => {
  if (stopping) process.exit(130);
  stopping = true;
  log('stopping after the current job (Ctrl-C again to quit now)');
});
while (!stopping) {
  await drain();
  for (let waited = 0; waited < intervalSeconds && !stopping; waited += 1) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
process.exit(0);
