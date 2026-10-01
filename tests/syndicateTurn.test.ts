/**
 * Offline tests of the turn runtime (lib/runtime/syndicateTurn.ts) driving
 * REAL ADK objects — Runner, LlmAgent, AgentTool, InMemorySessionService —
 * with scripted models. No network. These are the characterization suite for
 * the boundary between this framework and ADK: if an ADK upgrade or a
 * replacement of the loop changes delegation, the step cap, cancellation,
 * session history or plan-dispatch, a test here fails.
 */

process.env.OTEL_CONSOLE_SPANS = 'false';

import { test } from 'node:test';
import assert from 'node:assert';
import { InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest } from '@google/adk';

import { runSyndicateTurn } from '../lib/runtime/syndicateTurn.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import { ScriptedLlm, call, hangUntilAborted, scriptedResolver, sentTexts, text } from './helpers/scriptedLlm.ts';

setLogLevel(LogLevel.ERROR);

const APP = 'test-app';
const USER = 'u1';

function delegateConfig(extra: Partial<SyndicateYamlConfig> = {}): SyndicateYamlConfig {
  return {
    syndicate_name: 'Test',
    orchestrator: { name: 'Boss', model: 'scripted/boss', instruction: 'Delegate to Scout.' },
    subagents: [{ name: 'Scout', model: 'scripted/scout', instruction: 'Answer.', description: 'Finds things' }],
    ...extra,
  } as SyndicateYamlConfig;
}

function turn(config: SyndicateYamlConfig, models: Record<string, ScriptedLlm>, overrides: Record<string, unknown> = {}) {
  return runSyndicateTurn({
    config,
    parts: [{ text: 'find the thing' }],
    appName: APP,
    userId: USER,
    sessionId: 's1',
    sessionService: new InMemorySessionService(),
    compile: { resolveModel: scriptedResolver(models) },
    trace: false,
    ...overrides,
  });
}

test('delegate: the subagent receives the request argument and the relay ships', async () => {
  let scoutInput = '';
  const boss = new ScriptedLlm('scripted/boss', (_req, n) =>
    n === 1 ? call('Scout', { request: 'look in the attic' }) : text('Scout says: it is in the attic'),
  );
  const scout = new ScriptedLlm('scripted/scout', (req: LlmRequest) => {
    scoutInput = sentTexts(req).join(' ');
    return text('it is in the attic');
  });
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'Scout says: it is in the attic');
  assert.match(scoutInput, /look in the attic/);
  assert.deepEqual(r.answer?.delegations, ['Scout']);
  assert.equal(r.relayFallback, false);
  assert.equal(r.llmCalls, 3);
});

test('delegate: a relay that returns no text falls back to the last tool result', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => (n === 1 ? call('Scout', { request: 'go' }) : text('')));
  const scout = new ScriptedLlm('scripted/scout', () => text('the full specialist report'));
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'the full specialist report');
  assert.equal(r.relayFallback, true);
});

test('max_steps caps model calls across the whole turn, subagents included', async () => {
  // The orchestrator delegates forever; every delegation also costs the
  // subagent a call. ADK's own per-Runner ceiling is 500 and resets inside
  // each AgentTool, so without the turn budget this would run ~1000 calls.
  const boss = new ScriptedLlm('scripted/boss', () => call('Scout', { request: 'again' }));
  const scout = new ScriptedLlm('scripted/scout', () => text('still nothing'));
  const r = await turn(delegateConfig({ max_steps: 5 }), { boss, scout });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'STEP_LIMIT');
  assert.equal(r.stopReason, 'step_limit');
  assert.ok(boss.calls + scout.calls <= 5, `made ${boss.calls + scout.calls} calls`);
  assert.equal(r.llmCalls, 5);
});

test('cancel: aborting the signal stops a hung provider call', async () => {
  const controller = new AbortController();
  const boss = new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal));
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  setTimeout(() => controller.abort(), 30);
  const r = await turn(delegateConfig(), { boss, scout }, { signal: controller.signal });
  assert.equal(r.status, 'canceled');
  assert.equal(r.error?.code, 'CANCELED');
});

test('deadline: a turn that exceeds its time budget fails with DEADLINE_EXCEEDED', async () => {
  const boss = new ScriptedLlm('scripted/boss', (_req, _n, signal) => hangUntilAborted(signal));
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  const started = Date.now();
  const r = await turn(delegateConfig(), { boss, scout }, { deadlineMs: 40 });
  assert.equal(r.status, 'failed');
  assert.equal(r.error?.code, 'DEADLINE_EXCEEDED');
  assert.ok(Date.now() - started < 2000);
});

test('session: the second turn sees the first turn in its history', async () => {
  const sessions = new InMemorySessionService();
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => text(n === 1 ? 'first answer' : 'second answer'));
  const config = { syndicate_name: 'Solo', orchestrator: { name: 'Solo', model: 'scripted/boss', instruction: 'x' }, subagents: [] } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      config,
      parts: [{ text: msg }],
      appName: APP,
      userId: USER,
      sessionId: 'conv',
      sessionService: sessions,
      compile: { resolveModel: scriptedResolver({ boss }) },
      trace: false,
    });
  const first = await run('hello');
  const second = await run('again');
  assert.equal(first.resumedSession, false);
  assert.equal(second.resumedSession, true);
  const history = sentTexts(boss.requests[1]).join(' | ');
  assert.match(history, /hello/);
  assert.match(history, /first answer/);
  assert.match(history, /again/);
});

function dispatchConfig(): SyndicateYamlConfig {
  return {
    syndicate_name: 'Desk',
    orchestrator: { name: 'Router', model: 'scripted/router', instruction: 'Classify.' },
    subagents: [
      { name: 'Chat', model: 'scripted/chat', instruction: 'Chat.', description: 'small talk' },
      { name: 'Research', model: 'scripted/research', instruction: 'Research.', description: 'research' },
    ],
    dispatch: {
      default_route: 'Chat',
      route_overrides: [{ pattern: 'x\\.com/', route: 'Research', reason: 'X link' }],
    },
  } as unknown as SyndicateYamlConfig;
}

test('dispatch: the classifier picks the route and the route answers directly', async () => {
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Research","reason":"needs sources"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat answer'));
  const research = new ScriptedLlm('scripted/research', () => text('research answer'));
  const progress: string[] = [];
  const r = await turn(dispatchConfig(), { router, chat, research }, { events: { onProgress: (t: string) => progress.push(t) } });
  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'research answer');
  assert.equal(r.route?.route, 'Research');
  assert.equal(r.route?.decidedBy, 'classifier');
  assert.equal(chat.calls, 0);
  assert.ok(progress.some((p) => p.startsWith('Routed to Research')));
});

test('dispatch: an override pins the route without calling the classifier', async () => {
  const router = new ScriptedLlm('scripted/router', () => text('{"route":"Chat"}'));
  const chat = new ScriptedLlm('scripted/chat', () => text('chat'));
  const research = new ScriptedLlm('scripted/research', () => text('research'));
  const r = await turn(dispatchConfig(), { router, chat, research }, { parts: [{ text: 'read https://x.com/a/status/1' }] });
  assert.equal(r.route?.route, 'Research');
  assert.equal(r.route?.decidedBy, 'override');
  assert.equal(router.calls, 0);
});

test('dispatch: a failing classifier falls back to default_route and still answers', async () => {
  const router = new ScriptedLlm('scripted/router', () => ({ errorCode: '503', errorMessage: 'overloaded' }) as any);
  const chat = new ScriptedLlm('scripted/chat', () => text('default answer'));
  const research = new ScriptedLlm('scripted/research', () => text('research'));
  const r = await turn(dispatchConfig(), { router, chat, research });
  assert.equal(r.status, 'completed');
  assert.equal(r.route?.route, 'Chat');
  assert.equal(r.route?.fellBack, true);
  assert.equal(r.text, 'default answer');
});

test('a model error fails the turn and names the stage', async () => {
  const boss = new ScriptedLlm('scripted/boss', () => ({ errorCode: '429', errorMessage: 'rate limited' }) as any);
  const scout = new ScriptedLlm('scripted/scout', () => text('x'));
  const r = await turn(delegateConfig(), { boss, scout });
  assert.equal(r.status, 'failed');
  assert.equal(r.failedStage, 'delegate');
  assert.equal(r.error?.code, '429');
});

test('includeContents: none keeps earlier turns out of the model request', async () => {
  const sessions = new InMemorySessionService();
  const boss = new ScriptedLlm('scripted/boss', (_req, n) => text(`answer ${n}`));
  const config = {
    syndicate_name: 'Stateless',
    orchestrator: { name: 'Stateless', model: 'scripted/boss', instruction: 'x', includeContents: 'none' },
    subagents: [],
  } as any;
  const run = (msg: string) =>
    runSyndicateTurn({
      config,
      parts: [{ text: msg }],
      appName: APP,
      userId: USER,
      sessionId: 'stateless',
      sessionService: sessions,
      compile: { resolveModel: scriptedResolver({ boss }) },
      trace: false,
    });
  await run('first document: SECRET-A');
  await run('second document');
  const history = sentTexts(boss.requests[1]).join(' | ');
  assert.doesNotMatch(history, /SECRET-A/);
  assert.match(history, /second document/);
});

test('a caller with no model resolver still gets the framework adapters (step cap, cancel)', async () => {
  const { LLMRegistry } = await import('@google/adk');
  const { TracedGemini } = await import('../lib/models/registry.ts');
  const aborted = new AbortController();
  aborted.abort();
  const r = await runSyndicateTurn({
    config: {
      syndicate_name: 'Plain',
      memory_system: 'internal-only',
      orchestrator: { name: 'Lead', model: 'gemini-3.1-flash-lite', instruction: 'Lead.' },
      subagents: [],
    } as SyndicateYamlConfig,
    parts: [{ text: 'hi' }],
    appName: 'test',
    userId: 'u',
    sessionId: 's-plain',
    sessionService: new InMemorySessionService(),
    signal: aborted.signal,
    trace: false,
  });
  assert.equal(LLMRegistry.resolve('gemini-3.1-flash-lite'), TracedGemini);
  assert.notEqual(r.status, 'completed');
  assert.equal(r.llmCalls, 0);
});
