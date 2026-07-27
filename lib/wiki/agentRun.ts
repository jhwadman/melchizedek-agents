/**
 * lib/wiki/agentRun.ts — one-shot agent execution for wiki operations.
 *
 * WHY this file exists:
 *   Three wiki operations need a model in the loop — gap-fill (write the
 *   prose a structural build can't), wiki_query (answer a question over the
 *   bundle), wiki_garden (author or revise a document). Each is a single
 *   agent run: build an ADK LlmAgent, hand it the wiki FunctionTools it
 *   needs, stream one exchange, return the text. This helper is that idiom
 *   (the same one scripts/demo_model_optionality.ts uses), shared so the
 *   three call sites can't drift.
 *
 *   Model routing goes through lib/models/registry.ts, so the YAML-style
 *   model string ('gemini-3.6-flash', 'claude-*', 'ollama/*'…) picks the
 *   provider — wiki operations inherit the framework's full model
 *   optionality. A missing provider key degrades to a clear error string;
 *   nothing here throws for want of credentials.
 */

import { randomUUID } from 'node:crypto';

import { InMemorySessionService, LlmAgent, Runner } from '@google/adk';
import type { FunctionTool } from '@google/adk';

import {
  providerForModel,
  providerKeyPresent,
  registerAvailableProviders,
} from '../models/registry.ts';

export interface WikiAgentRun {
  name: string;
  description: string;
  model: string;
  instruction: string;
  userText: string;
  tools?: FunctionTool[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface WikiAgentResult {
  text: string;
  error?: string;
}

/** True when the model's provider has credentials (Ollama needs none). */
export function modelAvailable(model: string): { ok: boolean; reason?: string } {
  const provider = providerForModel(model);
  if (provider === 'ollama' || providerKeyPresent(provider)) return { ok: true };
  return { ok: false, reason: `provider "${provider}" has no API key configured` };
}

export async function runWikiAgent(run: WikiAgentRun): Promise<WikiAgentResult> {
  const availability = modelAvailable(run.model);
  if (!availability.ok) {
    return { text: '', error: availability.reason };
  }
  registerAvailableProviders();

  const agent = new LlmAgent({
    name: run.name,
    description: run.description,
    model: run.model,
    instruction: run.instruction,
    generateContentConfig: {
      temperature: run.temperature ?? 0.3,
      maxOutputTokens: run.maxOutputTokens ?? 4096,
    } as never,
    ...(run.tools && run.tools.length > 0 ? { tools: run.tools } : {}),
  });

  const appName = 'melchizedek-wiki';
  const userId = 'wiki';
  const sessionId = randomUUID();
  const sessionService = new InMemorySessionService();
  const runner = new Runner({ agent, appName, sessionService });
  await sessionService.createSession({ appName, userId, sessionId, state: {} });

  let outputText = '';
  let errorText = '';
  try {
    const stream = runner.runAsync({
      userId,
      sessionId,
      newMessage: { role: 'user', parts: [{ text: run.userText }] },
    });
    for await (const event of stream) {
      const evAny = event as { errorCode?: string; errorMessage?: string };
      if ((evAny.errorCode || evAny.errorMessage) && evAny.errorCode !== 'STOP') {
        errorText = `[${evAny.errorCode ?? 'ERROR'}] ${evAny.errorMessage ?? ''}`;
      }
      for (const part of event.content?.parts ?? []) {
        const p = part as { thought?: boolean; text?: string };
        if (!p.thought && p.text) outputText += p.text;
      }
    }
  } catch (err) {
    errorText = err instanceof Error ? err.message : String(err);
  }

  return {
    text: outputText.trim(),
    ...(errorText ? { error: errorText } : {}),
  };
}
