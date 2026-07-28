/**
 * scripts/direct_call.ts — the no-syndicate path.
 *
 * Proof that melchizedek is plain Google ADK underneath: ONE agent, ONE
 * prompt, ZERO YAML. No loadSyndicate(), no config/agents/, no
 * orchestrator/subagent graph — the syndicate structure is a convenience
 * this framework adds, never a requirement. If you are embedding
 * melchizedek in your own application, the block marked "conventional
 * ADK call" below is the whole integration surface: copy it into any
 * repo that has `@google/adk` installed and it runs as-is.
 *
 * The only melchizedek imports are two optional conveniences:
 *   loadEnv()                    — reads .env into process.env
 *   registerAvailableProviders() — makes `model:` route to ANY provider
 *                                  (claude-*, gpt-*, grok-*, ollama/*).
 *                                  Skip it and ADK still handles gemini-*.
 *
 * Usage:
 *   npm run demo:direct
 *   npm run demo:direct -- write a haiku about type safety
 *   npm run demo:direct -- --model claude-sonnet-4-6 why is the sky blue
 *   npm run demo:direct -- --model ollama/qwen3:8b hello   # keyless, local
 */

import {
  LlmAgent,
  Runner,
  InMemorySessionService,
  setLogLevel,
  LogLevel,
} from '@google/adk';

import { DEFAULT_GEMINI_MODEL } from '../lib/config.ts';
import { loadEnv } from '../lib/loadEnv.ts';
import {
  registerAvailableProviders,
  providerForModel,
  providerKeyPresent,
  PROVIDERS,
} from '../lib/models/registry.ts';

loadEnv(import.meta.url);
setLogLevel(LogLevel.WARN);
registerAvailableProviders();

// ── CLI: [--model <id>] [prompt words…] ──────────────────────────────────────
const argv = process.argv.slice(2).filter((a) => a !== '--');
let model = DEFAULT_GEMINI_MODEL;
const words: string[] = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--model' && i + 1 < argv.length) {
    model = argv[++i];
  } else {
    words.push(argv[i]);
  }
}
const prompt =
  words.length > 0 ? words.join(' ') : 'In one sentence: what is an agent?';

// Fail fast with the missing env var's NAME instead of a deep API error.
// (Ollama models pass unconditionally — local inference needs no key.)
const provider = providerForModel(model);
if (!providerKeyPresent(provider)) {
  console.error(
    `✗ ${PROVIDERS[provider].label} requires ${PROVIDERS[provider].keyEnv}, which is not set.`,
  );
  process.exit(1);
}

// ── The conventional ADK call — this block is the whole point ────────────────
const agent = new LlmAgent({
  name: 'direct_assistant',
  model, // a plain model-id string; the LLMRegistry routes it
  description: 'A single agent invoked without any syndicate structure.',
  instruction: 'You are a concise, helpful assistant. Answer directly.',
});

const appName = 'direct-call';
const sessionService = new InMemorySessionService();
const runner = new Runner({ agent, appName, sessionService });

const session = await sessionService.createSession({
  appName,
  userId: 'local-user',
});

console.log(`\n[direct] model=${model} — no syndicate, no YAML`);
console.log(`You › ${prompt}\n`);

for await (const event of runner.runAsync({
  userId: 'local-user',
  sessionId: session.id,
  newMessage: { role: 'user', parts: [{ text: prompt }] },
})) {
  // LlmResponse can carry errorCode/errorMessage without throwing —
  // surface them instead of silently printing nothing.
  const evAny = event as any;
  if ((evAny.errorCode || evAny.errorMessage) && evAny.errorCode !== 'STOP') {
    console.error(`⚠ [${evAny.errorCode ?? 'ERROR'}] ${evAny.errorMessage ?? ''}`);
  }
  for (const part of event.content?.parts ?? []) {
    if (part.text && !(part as any).thought) process.stdout.write(part.text);
  }
}
process.stdout.write('\n');
