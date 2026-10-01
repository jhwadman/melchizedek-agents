/**
 * tests/capabilityMatrix.test.ts — every `evidence: 'test'` cell of
 * CAPABILITY_MATRIX (lib/models/capabilities.ts), asserted against the request
 * body the adapter actually sends.
 *
 * Offline: globalThis.fetch is replaced by a stub that records the request
 * and answers 400, so no provider is called and no SDK retries. Keys are
 * fake values set for the duration of each capture.
 *
 * The point is drift: change what an adapter sends without changing its row
 * in the matrix and one of these fails; change a row without the adapter and
 * it fails too. Every cell must have a check (the last test enforces that).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { setLogLevel, LogLevel, LlmAgent, AgentTool, LOAD_MEMORY } from '@google/adk';
import type { LlmRequest, LlmResponse } from '@google/adk';

import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  capabilityGaps,
  capabilityOf,
  renderCapabilityMatrix,
  requiredCapabilities,
} from '../lib/models/capabilities.ts';
import type { Capability, MatrixRow } from '../lib/models/capabilities.ts';
import { ClaudeLlm } from '../lib/models/claudeLlm.ts';
import { GptLlm } from '../lib/models/gptLlm.ts';
import { GrokLlm } from '../lib/models/grokLlm.ts';
import { OllamaLlm } from '../lib/models/ollamaLlm.ts';
import { GatewayLlm } from '../lib/models/gatewayLlm.ts';
import { WEB_SEARCH } from '../lib/tools/webSearchTool.ts';

setLogLevel(LogLevel.ERROR);
// The tracer prints every llm.request span to stdout unless told not to.
process.env.OTEL_CONSOLE_SPANS = 'false';

// ── Capture harness ──────────────────────────────────────────────────────────

type AdapterRow = Exclude<MatrixRow, 'gemini'>;

const FAKE_ENV: Record<AdapterRow, Record<string, string>> = {
  anthropic: { ANTHROPIC_API_KEY: 'fixture-ant-test-0123456789abcdef' }, // gitleaks:allow (test fixture)
  openai: { OPENAI_API_KEY: 'fixture-openai-0123456789abcdef' }, // gitleaks:allow (test fixture)
  xai: { XAI_API_KEY: 'fixture-xai-0123456789abcdef' }, // gitleaks:allow (test fixture)
  ollama: {},
  gateway: { MODEL_GATEWAY: 'openrouter', MODEL_GATEWAY_API_KEY: 'fixture-gateway-0123456789abcdef' },
};

/** The env vars any capture touches, cleared so a developer's real keys never route a test. */
const ALL_ENV = [
  ...new Set(Object.values(FAKE_ENV).flatMap((e) => Object.keys(e))),
  'MODEL_GATEWAY_BASE_URL',
  'MODEL_GATEWAY_MODEL_MAP',
];

const MODEL: Record<AdapterRow, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-5-mini',
  xai: 'grok-4.5',
  ollama: 'ollama/qwen3:8b',
  // A provider whose direct key is absent, so the gateway serves it.
  gateway: 'claude-sonnet-4-6',
};

function adapterFor(row: AdapterRow) {
  const model = MODEL[row];
  switch (row) {
    case 'anthropic':
      return new ClaudeLlm({ model });
    case 'openai':
      return new GptLlm({ model });
    case 'xai':
      return new GrokLlm({ model });
    case 'ollama':
      return new OllamaLlm({ model });
    case 'gateway':
      return new GatewayLlm({ model });
  }
}

function request(row: AdapterRow, overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: MODEL[row],
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    liveConnectConfig: {} as any,
    toolsDict: {},
    config: {},
    ...overrides,
  } as LlmRequest;
}

/** Sends one request through the adapter and returns the JSON body it posted. */
async function capture(row: AdapterRow, req: LlmRequest, stream = false): Promise<any> {
  const saved = Object.fromEntries(ALL_ENV.map((k) => [k, process.env[k]]));
  for (const k of ALL_ENV) delete process.env[k];
  Object.assign(process.env, FAKE_ENV[row]);
  const originalFetch = globalThis.fetch;
  let body: any;
  globalThis.fetch = (async (input: any, init: any) => {
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    if (body === undefined && typeof raw === 'string') body = JSON.parse(raw);
    return new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'captured' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as any;
  try {
    const llm = adapterFor(row);
    const gen = llm.generateContentAsync(req, stream) as AsyncGenerator<LlmResponse, void>;
    for await (const _ of gen) {
      // drain; the 400 surfaces as an error response, which is expected
    }
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ALL_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  assert.ok(body, `${row}: the adapter sent no request`);
  return body;
}

// ── Readers: one shape per wire dialect ──────────────────────────────────────

type Dialect = 'anthropic' | 'responses' | 'chat';
const DIALECT: Record<AdapterRow, Dialect> = {
  anthropic: 'anthropic',
  openai: 'responses',
  xai: 'responses',
  ollama: 'chat',
  gateway: 'chat',
};

function toolSchema(row: AdapterRow, body: any, name: string): any {
  const tools: any[] = body.tools ?? [];
  switch (DIALECT[row]) {
    case 'anthropic':
      return tools.find((t) => t.name === name)?.input_schema;
    case 'responses':
      return tools.find((t) => t.name === name)?.parameters;
    case 'chat':
      return tools.find((t) => t.function?.name === name)?.function?.parameters;
  }
}

function hasImage(row: AdapterRow, body: any): boolean {
  const text = JSON.stringify(row === 'anthropic' ? body.messages : DIALECT[row] === 'responses' ? body.input : body.messages);
  return /"type":"(image|input_image|image_url)"/.test(text);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

const SCHEMA = {
  type: 'OBJECT',
  properties: { verdict: { type: 'STRING' } },
  required: ['verdict'],
};

function withDelegationTools(row: AdapterRow): LlmRequest {
  const sub = new LlmAgent({ name: 'Scout', description: 'Finds things', model: 'gemini-3.1-flash-lite', instruction: 'x' });
  const req = request(row);
  req.toolsDict['Scout'] = new AgentTool({ agent: sub });
  req.toolsDict['load_memory'] = LOAD_MEMORY as any;
  return req;
}

/** A thinking agent mid tool loop: a prior model turn with thought + call, then the result. */
function thinkingToolLoop(row: AdapterRow): LlmRequest {
  const req = withDelegationTools(row);
  req.config = { thinkingConfig: { thinkingBudget: 2048 }, reasoningEffort: 'low' } as any;
  req.contents = [
    { role: 'user', parts: [{ text: 'look it up' }] },
    {
      role: 'model',
      parts: [
        { text: 'I should ask Scout.', thought: true } as any,
        { functionCall: { id: 'call_1', name: 'Scout', args: { request: 'find it' } } },
      ],
    },
    { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'Scout', response: { result: 'found' } } }] },
  ];
  return req;
}

// ── One check per capability; each returns the support the request shows ────

type Observed = 'supported' | 'degraded' | 'unsupported';

const CHECKS: Record<Capability, (row: AdapterRow) => Promise<Observed>> = {
  async delegation(row) {
    const s = toolSchema(row, await capture(row, withDelegationTools(row)), 'Scout');
    return s?.properties?.request?.type === 'string' && s.required?.includes('request') ? 'supported' : 'unsupported';
  },

  async memory_tools(row) {
    const s = toolSchema(row, await capture(row, withDelegationTools(row)), 'load_memory');
    return s?.properties?.query ? 'supported' : 'unsupported';
  },

  async structured_output(row) {
    const body = await capture(row, request(row, { config: { responseSchema: SCHEMA, responseMimeType: 'application/json' } as any }));
    switch (DIALECT[row]) {
      case 'anthropic': {
        const forced = body.tool_choice?.type === 'tool';
        const declared = (body.tools ?? []).some((t: any) => t.name === body.tool_choice?.name && t.input_schema?.properties?.verdict);
        return forced && declared ? 'supported' : 'unsupported';
      }
      case 'responses':
        return body.text?.format?.type === 'json_schema' && body.text.format.schema?.properties?.verdict ? 'supported' : 'unsupported';
      case 'chat': {
        const f = body.response_format;
        if (f?.type === 'json_schema' && f.json_schema?.schema?.properties?.verdict) return 'supported';
        return f?.type === 'json_object' ? 'degraded' : 'unsupported';
      }
    }
  },

  async thinking_with_tools(row) {
    const body = await capture(row, thinkingToolLoop(row));
    switch (DIALECT[row]) {
      case 'anthropic': {
        // Anthropic needs the signed thinking block replayed before the tool_use.
        const assistant = (body.messages ?? []).find((m: any) => m.role === 'assistant');
        const replayed = (assistant?.content ?? []).some((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking');
        if (!body.thinking) return 'unsupported';
        return replayed ? 'supported' : 'unsupported';
      }
      case 'responses': {
        const reasons = !!body.reasoning;
        const tools = (body.tools ?? []).length > 0;
        const replayed = (body.input ?? []).some((i: any) => i.type === 'reasoning');
        if (!reasons || !tools) return 'unsupported';
        return replayed ? 'supported' : 'degraded';
      }
      case 'chat': {
        const tools = (body.tools ?? []).length > 0;
        if (!tools) return 'unsupported';
        // The budget has no wire form here; only reasoning_effort travels.
        return body.reasoning_effort === 'low' && !('thinking' in body) ? 'degraded' : 'unsupported';
      }
    }
  },

  async streaming(row) {
    const body = await capture(row, request(row), true);
    return body.stream === true ? 'supported' : 'unsupported';
  },

  async vision(row) {
    const req = request(row, {
      contents: [{ role: 'user', parts: [{ text: 'what is this?' }, { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } }] }],
    });
    return hasImage(row, await capture(row, req)) ? 'supported' : 'unsupported';
  },

  async native_search(row) {
    const req = request(row);
    req.toolsDict['web_search'] = WEB_SEARCH as any;
    const body = await capture(row, req);
    const text = JSON.stringify(body.tools ?? []) + JSON.stringify(body.web_search_options ?? '') + JSON.stringify(body.plugins ?? '');
    return /web_search/.test(text) ? 'supported' : 'unsupported';
  },
};

// ── The tests ────────────────────────────────────────────────────────────────

const ADAPTER_ROWS = (Object.keys(CAPABILITY_MATRIX) as MatrixRow[]).filter((r): r is AdapterRow => r !== 'gemini');

for (const row of ADAPTER_ROWS) {
  for (const cap of CAPABILITIES) {
    const cell = CAPABILITY_MATRIX[row][cap];
    test(`matrix ${row} · ${cap}: ${cell.support}`, async () => {
      assert.equal(cell.evidence, 'test', `${row}.${cap} is built by this repo, so it must be tested`);
      assert.equal(await CHECKS[cap](row), cell.support);
    });
  }
}

test('matrix: Gemini cells are ADK-native and every non-supported cell explains itself', () => {
  for (const cap of CAPABILITIES) {
    assert.equal(CAPABILITY_MATRIX.gemini[cap].evidence, 'adk', `gemini.${cap}`);
  }
  for (const [row, cells] of Object.entries(CAPABILITY_MATRIX)) {
    for (const [cap, cell] of Object.entries(cells)) {
      if (cell.support !== 'supported') assert.ok(cell.note, `${row}.${cap} needs a note saying what is lost`);
    }
  }
});

test('requiredCapabilities reads what an agent asks of its model', () => {
  assert.deepEqual(requiredCapabilities({}), []);
  assert.deepEqual(
    requiredCapabilities({ delegates: true, tools: ['load_memory', 'web_search'], outputSchema: {} }).sort(),
    ['delegation', 'memory_tools', 'native_search', 'structured_output'],
  );
  // Thinking matters only alongside tools or delegation; a zero budget is off.
  assert.deepEqual(requiredCapabilities({ generateContentConfig: { thinkingConfig: { thinkingBudget: 1024 } } }), []);
  assert.ok(
    requiredCapabilities({ tools: ['web_extract'], generateContentConfig: { thinkingConfig: { thinkingBudget: 1024 } } }).includes(
      'thinking_with_tools',
    ),
  );
  assert.ok(
    !requiredCapabilities({ tools: ['web_extract'], generateContentConfig: { thinkingConfig: { thinkingBudget: 0 } } }).includes(
      'thinking_with_tools',
    ),
  );
});

test('capabilityGaps resolves the path first: a gateway-served id gets the gateway row', () => {
  const saved = { a: process.env.ANTHROPIC_API_KEY, g: process.env.MODEL_GATEWAY, k: process.env.MODEL_GATEWAY_API_KEY };
  try {
    process.env.ANTHROPIC_API_KEY = FAKE_ENV.anthropic.ANTHROPIC_API_KEY;
    delete process.env.MODEL_GATEWAY;
    delete process.env.MODEL_GATEWAY_API_KEY;
    assert.equal(capabilityOf('claude-sonnet-4-6', 'vision').row, 'anthropic');
    assert.deepEqual(
      capabilityGaps('claude-sonnet-4-6', { tools: ['web_extract'], generateContentConfig: { thinkingConfig: { thinkingBudget: 2048 } } }).map(
        (g) => `${g.capability}:${g.support}`,
      ),
      ['thinking_with_tools:unsupported'],
    );

    delete process.env.ANTHROPIC_API_KEY;
    Object.assign(process.env, FAKE_ENV.gateway);
    assert.equal(capabilityOf('claude-sonnet-4-6', 'native_search').row, 'gateway');
    assert.deepEqual(
      capabilityGaps('claude-sonnet-4-6', { tools: ['web_search'] }).map((g) => g.capability),
      ['native_search'],
    );
  } finally {
    for (const [k, v] of [['ANTHROPIC_API_KEY', saved.a], ['MODEL_GATEWAY', saved.g], ['MODEL_GATEWAY_API_KEY', saved.k]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('renderCapabilityMatrix covers every row and capability, with numbered notes', () => {
  const md = renderCapabilityMatrix();
  for (const cap of CAPABILITIES) assert.ok(md.includes(cap.replace(/_/g, ' ').split(' ')[0]), cap);
  assert.match(md, /^\| Capability \|/);
  assert.match(md, /Gateway \(any id\)/);
  const noted = Object.values(CAPABILITY_MATRIX).flatMap((r) => Object.values(r)).filter((c) => c.note).length;
  assert.ok(md.includes(`\n${noted}. `), 'one numbered note per annotated cell');
});
