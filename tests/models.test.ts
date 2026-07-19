/**
 * tests/models.test.ts — offline tests for model optionality.
 *
 * Everything here runs with NO network and NO API keys:
 *   - schema normalization (the Gemini-uppercase → lowercase bridge)
 *   - model-name → provider routing (the prefix table)
 *   - provider availability gating (env-based, registration is pure)
 *   - adapter usage/thinking extraction against a stubbed fetch
 *   - the web_search tool's per-provider request shaping
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { setLogLevel, LogLevel } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import { toLowercaseJsonSchema } from '../lib/models/schemaNormalize.ts';
import {
  providerForModel,
  providerKeyPresent,
  providerStatuses,
  resolveModel,
} from '../lib/models/registry.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { ClaudeLlm, buildAnthropicTools } from '../lib/models/claudeLlm.ts';
import { GptLlm, buildResponsesInput, buildResponsesTools } from '../lib/models/gptLlm.ts';
import { splitThinkBlocks, mapUsage } from '../lib/models/openAiCompatibleLlm.ts';
import { WebSearchTool, WEB_SEARCH, wantsWebSearch } from '../lib/tools/webSearchTool.ts';

setLogLevel(LogLevel.WARN);

/** Minimal LlmRequest for adapter tests. */
function makeRequest(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'ollama/qwen3:8b',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    liveConnectConfig: {} as any,
    toolsDict: {},
    ...overrides,
  } as LlmRequest;
}

async function collect(gen: AsyncGenerator<LlmResponse, void>): Promise<LlmResponse[]> {
  const out: LlmResponse[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

// ── Schema normalization ─────────────────────────────────────────────────────

test('toLowercaseJsonSchema lowercases types deeply, preserving enum/description', () => {
  const gemini = {
    type: 'OBJECT',
    properties: {
      topic: { type: 'STRING', description: 'The topic', enum: ['A', 'B'] },
      depth: { type: 'INTEGER' },
      tags: { type: 'ARRAY', items: { type: 'STRING' } },
      nested: {
        type: 'OBJECT',
        properties: { flag: { type: 'BOOLEAN' } },
        required: ['flag'],
      },
    },
    required: ['topic'],
  };
  const normalized = toLowercaseJsonSchema(gemini) as any;
  assert.equal(normalized.type, 'object');
  assert.equal(normalized.properties.topic.type, 'string');
  assert.deepEqual(normalized.properties.topic.enum, ['A', 'B']); // enum values keep casing
  assert.equal(normalized.properties.topic.description, 'The topic');
  assert.equal(normalized.properties.tags.items.type, 'string');
  assert.equal(normalized.properties.nested.properties.flag.type, 'boolean');
  assert.deepEqual(normalized.required, ['topic']);
  // Never mutates the input — a Gemini agent may share the object.
  assert.equal(gemini.type, 'OBJECT');
  assert.equal(gemini.properties.nested.properties.flag.type, 'BOOLEAN');
});

test('toLowercaseJsonSchema handles type arrays and non-object input', () => {
  const schema = { type: ['STRING', 'NULL'] };
  assert.deepEqual((toLowercaseJsonSchema(schema) as any).type, ['string', 'null']);
  assert.deepEqual(toLowercaseJsonSchema(undefined), { type: 'object', properties: {} });
});

// ── Provider routing ─────────────────────────────────────────────────────────

test('providerForModel maps every prefix to its provider', () => {
  assert.equal(providerForModel('claude-sonnet-4-6'), 'anthropic');
  assert.equal(providerForModel('gpt-5-mini'), 'openai');
  assert.equal(providerForModel('o4-mini'), 'openai');
  assert.equal(providerForModel('grok-4-1-fast-reasoning'), 'xai');
  assert.equal(providerForModel('ollama/qwen3:8b'), 'ollama');
  assert.equal(providerForModel('gemini-3.1-flash-lite'), 'gemini');
  assert.equal(providerForModel('something-unknown'), 'gemini'); // ADK-native default
});

test('resolveModel returns the right adapter instance; model id wins over header', () => {
  assert.ok(resolveModel('ollama/qwen3:8b', { defaultProvider: 'anthropic' }) instanceof OllamaLlm);
  assert.ok(resolveModel('claude-sonnet-4-6') instanceof ClaudeLlm);
  assert.ok(resolveModel('grok-4-1-fast-reasoning') instanceof GrokLlm);
  assert.ok(resolveModel('gpt-5-mini') instanceof GptLlm);
});

test('resolveModel uses the deprecated provider header only when model is absent', () => {
  assert.ok(resolveModel(undefined, { defaultProvider: 'ollama' }) instanceof OllamaLlm);
  assert.ok(resolveModel(undefined, { defaultProvider: 'anthropic' }) instanceof ClaudeLlm);
});

test('providerStatuses reflects env keys; ollama is always available', () => {
  const saved = { ...process.env };
  try {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.GOOGLE_GENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const off = Object.fromEntries(providerStatuses().map((s) => [s.provider, s.available]));
    assert.deepEqual(off, { gemini: false, anthropic: false, openai: false, xai: false, ollama: true });

    process.env.XAI_API_KEY = 'test-key';
    assert.equal(providerKeyPresent('xai'), true);
    process.env.GEMINI_API_KEY = 'test-key'; // either Gemini env name counts
    assert.equal(providerKeyPresent('gemini'), true);
  } finally {
    process.env = saved;
  }
});

// ── OpenAI-compatible base: reasoning + usage extraction ────────────────────

test('splitThinkBlocks separates the scratchpad from the answer', () => {
  const { reasoning, answer } = splitThinkBlocks('<think>step 1\nstep 2</think>The answer.');
  assert.equal(reasoning, 'step 1\nstep 2');
  assert.equal(answer, 'The answer.');
  assert.deepEqual(splitThinkBlocks('plain'), { reasoning: '', answer: 'plain' });
});

test('mapUsage maps OpenAI-style usage to GenAI usageMetadata', () => {
  assert.deepEqual(
    mapUsage({
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
      completion_tokens_details: { reasoning_tokens: 5 },
    }),
    { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5, totalTokenCount: 30 },
  );
  assert.equal(mapUsage(undefined), undefined);
});

test('OllamaLlm yields thought part, answer, and usageMetadata from a stubbed response', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestBody: any;
  globalThis.fetch = (async (url: any, init: any) => {
    requestedUrl = String(url);
    requestBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: '<think>pondering</think>An answer.' } }],
        usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
      }),
      { status: 200 },
    );
  }) as any;
  try {
    const llm = new OllamaLlm({ model: 'ollama/qwen3:8b' });
    const responses = await collect(llm.generateContentAsync(makeRequest()));

    const thought = responses.find((r) => (r.content?.parts?.[0] as any)?.thought);
    assert.ok(thought, 'expected a thought part');
    assert.equal((thought!.content!.parts![0] as any).text, 'pondering');

    const final = responses.find((r) => r.turnComplete);
    assert.ok(final, 'expected a final response');
    assert.equal((final!.content!.parts![0] as any).text, 'An answer.');
    assert.equal(final!.usageMetadata?.promptTokenCount, 12);
    assert.equal(final!.usageMetadata?.candidatesTokenCount, 34);

    assert.match(requestedUrl, /\/chat\/completions$/);
    assert.equal(requestBody.model, 'qwen3:8b'); // ollama/ namespace stripped
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GrokLlm sends auth + search_parameters and surfaces reasoning_content', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: any;
  let authHeader = '';
  globalThis.fetch = (async (_url: any, init: any) => {
    requestBody = JSON.parse(init.body);
    authHeader = init.headers.Authorization;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'Grok answer.', reasoning_content: 'grokking' } }],
        usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
      }),
      { status: 200 },
    );
  }) as any;
  try {
    const llm = new GrokLlm({ model: 'grok-4-1-fast-reasoning', apiKey: 'xai-test' });
    const request = makeRequest({ model: 'grok-4-1-fast-reasoning' });
    request.toolsDict['web_search'] = WEB_SEARCH; // the non-Gemini sentinel
    const responses = await collect(llm.generateContentAsync(request));

    assert.equal(authHeader, 'Bearer xai-test');
    assert.deepEqual(requestBody.search_parameters, { mode: 'auto' }); // native search on
    assert.equal(requestBody.tools, undefined); // sentinel never sent as a function tool

    const thought = responses.find((r) => (r.content?.parts?.[0] as any)?.thought);
    assert.equal((thought!.content!.parts![0] as any).text, 'grokking');
    const final = responses.find((r) => r.turnComplete);
    assert.equal((final!.content!.parts![0] as any).text, 'Grok answer.');
    assert.equal(final!.usageMetadata?.candidatesTokenCount, 9);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ── Claude request building ──────────────────────────────────────────────────

test('buildAnthropicTools lowercases schemas and maps web_search to the server tool', () => {
  const request = makeRequest({ model: 'claude-sonnet-4-6' });
  request.toolsDict['search_catalog'] = {
    name: 'search_catalog',
    description: 'Search the catalog',
    parameters: { type: 'OBJECT', properties: { query: { type: 'STRING' } }, required: ['query'] },
  } as any;
  request.toolsDict['web_search'] = WEB_SEARCH;

  const tools = buildAnthropicTools(request);
  const fn = tools.find((t) => t.name === 'search_catalog');
  assert.equal(fn.input_schema.type, 'object'); // the uppercase-schema bug, fixed
  assert.equal(fn.input_schema.properties.query.type, 'string');

  const server = tools.find((t) => t.name === 'web_search');
  assert.equal(server.type, 'web_search_20250305'); // Anthropic-native server tool
  assert.equal(typeof server.input_schema, 'undefined');
});

// ── GPT (Responses API) request building ─────────────────────────────────────

test('buildResponsesInput maps contents, round-trips call_id, extracts instructions', () => {
  const request = makeRequest({
    model: 'gpt-5-mini',
    contents: [
      { role: 'system', parts: [{ text: 'Be concise.' }] } as any,
      { role: 'user', parts: [{ text: 'What is 2+2?' }] },
      { role: 'model', parts: [{ functionCall: { id: 'call_abc', name: 'calc', args: { a: 2 } } }] } as any,
      { role: 'user', parts: [{ functionResponse: { id: 'call_abc', name: 'calc', response: { result: 4 } } }] } as any,
    ],
  });
  const { instructions, input } = buildResponsesInput(request);
  assert.equal(instructions, 'Be concise.');
  const call = input.find((i) => i.type === 'function_call');
  const output = input.find((i) => i.type === 'function_call_output');
  assert.equal(call.call_id, 'call_abc');
  assert.equal(output.call_id, 'call_abc'); // Responses API requires the match
  const userMsg = input.find((i) => i.role === 'user');
  assert.equal(userMsg.content[0].type, 'input_text');
});

test('buildResponsesTools lowercases schemas and adds native web_search', () => {
  const request = makeRequest({ model: 'gpt-5-mini' });
  request.toolsDict['calc'] = {
    name: 'calc',
    description: 'Calculate',
    parameters: { type: 'OBJECT', properties: { a: { type: 'NUMBER' } } },
  } as any;
  request.toolsDict['web_search'] = WEB_SEARCH;
  const tools = buildResponsesTools(request);
  assert.equal(tools.find((t) => t.type === 'function').parameters.properties.a.type, 'number');
  assert.ok(tools.some((t) => t.type === 'web_search')); // OpenAI-native tool
});

// ── web_search tool routing ──────────────────────────────────────────────────

test('WebSearchTool: Gemini model gets grounding; others get the sentinel', async () => {
  const tool = new WebSearchTool();

  const geminiRequest = makeRequest({ model: 'gemini-3.1-flash-lite' });
  await tool.processLlmRequest({ llmRequest: geminiRequest } as any);
  assert.deepEqual((geminiRequest.config as any).tools, [{ googleSearch: {} }]);
  assert.equal(wantsWebSearch(geminiRequest), false); // no sentinel on Gemini

  const claudeRequest = makeRequest({ model: 'claude-sonnet-4-6' });
  await tool.processLlmRequest({ llmRequest: claudeRequest } as any);
  assert.equal((claudeRequest.config as any)?.tools, undefined); // no Gemini grounding
  assert.equal(wantsWebSearch(claudeRequest), true); // adapters read this
  assert.equal(tool._getDeclaration(), undefined); // never a client-side function tool
});
