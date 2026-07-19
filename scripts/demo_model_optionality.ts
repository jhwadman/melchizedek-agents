/**
 * scripts/demo_model_optionality.ts — the model-optionality proof.
 *
 * Sends ONE prompt ("explain quantum mechanics", or your own words after the
 * script name) to a lightweight agent of EVERY provider declared in
 * config/agents/model_zoo.yaml, purely by reading each agent's `model:`
 * string and letting lib/models/registry.ts route it:
 *
 *   ollama/qwen3:8b → Ollama (local)      claude-* → Anthropic
 *   grok-*          → xAI                 gpt-*    → OpenAI
 *   gemini-*        → Google
 *
 * For each provider it prints: INPUT, THINKING (when the model exposes it —
 * qwen3's <think> blocks, Claude extended thinking, GPT reasoning summaries,
 * Grok reasoning_content), OUTPUT, and a TRACE footer (wall time, input /
 * output / thinking tokens) read from the same llm.request OpenTelemetry
 * spans every entrypoint emits. Providers whose key (or local server) is
 * absent are SKIPPED — never fatal, so the demo runs on any machine.
 *
 * Flags:
 *   --search   also declare the provider-agnostic web_search tool on every
 *              agent: four providers enable their NATIVE search; the local
 *              model logs the omit warning (and stays keyless).
 *
 * Usage:
 *   npm run demo:models
 *   npm run demo:models -- --search
 *   npm run demo:models -- why is the sky blue
 *   TELEMETRY_SUPABASE=true npm run demo:models   # also insert adk_telemetry rows
 */

import { LlmAgent, Runner, InMemorySessionService, setLogLevel, LogLevel } from '@google/adk';
import { randomUUID } from 'node:crypto';

import { loadEnv } from '../lib/loadEnv.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import {
  registerAvailableProviders,
  providerForModel,
  PROVIDERS,
} from '../lib/models/registry.ts';
import {
  traceAgentRun,
  onSpanEnd,
  flushTracing,
} from '../lib/observability/tracer.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
};

const DEFAULT_PROMPT = 'explain quantum mechanics';

async function ollamaReachable(): Promise<{ up: boolean; detail: string }> {
  const baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1';
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok
      ? { up: true, detail: baseUrl }
      : { up: false, detail: `${baseUrl} returned ${res.status}` };
  } catch {
    return {
      up: false,
      detail: `Ollama not reachable at ${baseUrl} — start it with: ollama serve`,
    };
  }
}

async function main(): Promise<void> {
  loadEnv(import.meta.url);

  // Quiet the ADK's internal info logging so the demo output stays readable.
  setLogLevel(LogLevel.WARN);

  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const withSearch = argv.includes('--search');
  const promptWords = argv.filter((a) => a !== '--search');
  const prompt = promptWords.length > 0 ? promptWords.join(' ') : DEFAULT_PROMPT;

  // One call: every adapter whose credentials exist becomes routable.
  const statuses = registerAvailableProviders();
  const availability = new Map(statuses.map((s) => [s.provider, s]));
  const ollama = await ollamaReachable();

  // In-process span collector — the trace footer reads the same llm.request
  // spans that the [OTEL_SPAN_JSON] console lines carry.
  const llmSpans: any[] = [];
  const unsubscribe = onSpanEnd((span) => {
    if (span.name === 'llm.request') llmSpans.push(span);
  });

  const config = loadSyndicate('model_zoo.yaml');

  console.log(`\n${c.bold}MODEL OPTIONALITY DEMO${c.reset} — one prompt, five providers`);
  console.log(`${c.dim}Syndicate: ${config.syndicate_name} (config/agents/model_zoo.yaml)${c.reset}`);
  console.log(`${c.dim}web_search tool: ${withSearch ? 'DECLARED on every agent (--search)' : 'off (pass --search to enable)'}${c.reset}\n`);

  for (const sub of config.subagents) {
    const model = sub.model!;
    const provider = providerForModel(model);
    const label = PROVIDERS[provider].label;
    const banner = `${label} — ${model}`;

    console.log(`${c.bold}${'═'.repeat(66)}${c.reset}`);
    console.log(`${c.bold}${c.magenta}${banner}${c.reset}`);

    // Skip unavailable providers with the reason, never fatally.
    if (provider === 'ollama' && !ollama.up) {
      console.log(`${c.yellow}SKIPPED${c.reset} ${c.dim}(${ollama.detail})${c.reset}\n`);
      continue;
    }
    if (provider !== 'ollama' && !availability.get(provider)?.available) {
      console.log(`${c.yellow}SKIPPED${c.reset} ${c.dim}(${availability.get(provider)?.reason})${c.reset}\n`);
      continue;
    }

    const spanCountBefore = llmSpans.length;
    const agent = new LlmAgent({
      name: sub.name,
      description: sub.description,
      model, // ← the YAML string; the LLMRegistry routes it to the adapter
      instruction: sub.instruction,
      ...(sub.generateContentConfig
        ? { generateContentConfig: sub.generateContentConfig as any }
        : {}),
      ...(withSearch ? { tools: [WEB_SEARCH] } : {}),
    });

    const appName = 'model-zoo-demo';
    const sessionService = new InMemorySessionService();
    const runner = new Runner({ agent, appName, sessionService });
    const userId = 'demo-user';
    const sessionId = randomUUID();
    await sessionService.createSession({ appName, userId, sessionId, state: {} });

    console.log(`${c.cyan}INPUT${c.reset}    : ${prompt}`);

    const started = Date.now();
    let thinkingText = '';
    let outputText = '';
    let errorText = '';

    try {
      const stream = traceAgentRun(
        runner.runAsync({
          userId,
          sessionId,
          newMessage: { role: 'user', parts: [{ text: prompt }] },
        }),
        { syndicateName: `model-zoo/${sub.name}`, input: prompt },
      );

      for await (const event of stream) {
        const evAny = event as any;
        if ((evAny.errorCode || evAny.errorMessage) && evAny.errorCode !== 'STOP') {
          errorText = `[${evAny.errorCode ?? 'ERROR'}] ${evAny.errorMessage ?? ''}`;
        }
        for (const part of event.content?.parts ?? []) {
          const p = part as any;
          if (p.thought && p.text) thinkingText += p.text;
          else if (p.text) outputText += p.text;
        }
      }
    } catch (err: unknown) {
      errorText = err instanceof Error ? err.message : String(err);
    }
    const wallMs = Date.now() - started;

    if (thinkingText.trim()) {
      console.log(`${c.cyan}THINKING${c.reset} ${c.dim}: ${thinkingText.trim().replace(/\n/g, '\n           ')}${c.reset}`);
    } else {
      console.log(`${c.cyan}THINKING${c.reset} ${c.dim}: (not exposed by this model/request)${c.reset}`);
    }
    if (errorText) {
      console.log(`${c.yellow}ERROR${c.reset}    : ${errorText}`);
    }
    console.log(`${c.cyan}OUTPUT${c.reset}   : ${outputText.trim().replace(/\n/g, '\n           ')}`);

    // Trace footer: the llm.request spans this run emitted (one per model
    // call), the same data the [OTEL_SPAN_JSON] lines and — with
    // TELEMETRY_SUPABASE=true — the adk_telemetry table carry.
    const runSpans = llmSpans.slice(spanCountBefore);
    const sum = (key: string) =>
      runSpans.reduce((acc, s) => acc + (Number(s.attributes?.[key]) || 0), 0);
    const searchFlag = runSpans.some((s) => s.attributes?.['llm.web_search.native'])
      ? ' · web_search: native'
      : runSpans.some((s) => s.attributes?.['llm.web_search.omitted'])
        ? ' · web_search: omitted'
        : '';
    console.log(
      `${c.green}TRACE${c.reset}    : ${(wallMs / 1000).toFixed(1)}s wall · ` +
        `${runSpans.length} model call${runSpans.length === 1 ? '' : 's'} · ` +
        `tokens in ${sum('llm.tokens.input')} / out ${sum('llm.tokens.output')} / thinking ${sum('llm.tokens.thinking')}` +
        searchFlag,
    );
    console.log('');
  }

  unsubscribe();
  await flushTracing(); // don't drop Supabase telemetry rows on exit
  console.log(`${c.dim}Every request above emitted an [OTEL_SPAN_JSON] llm.request span; set TELEMETRY_SUPABASE=true (+ Supabase credentials + db/telemetry.sql) to persist them.${c.reset}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
