/**
 * tests/mcpAuth.test.ts — offline tests for the MCP client's credential scoping.
 *
 * mcp_server_url can come from registry-stored config, so the question each
 * case answers is: which URL receives a token? Only the exact host named in
 * MCP_BEARER_TOKENS, only over https. Every other URL gets no header at all.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { mcpAuthHeaders } from '../lib/tools/mcpToolFactory.ts';

const env = (tokens: unknown) =>
  ({ MCP_BEARER_TOKENS: typeof tokens === 'string' ? tokens : JSON.stringify(tokens) }) as NodeJS.ProcessEnv;

const ENV = env({ 'tools.example.com': 'tok-1' });

test('the named host over https gets its bearer token', () => {
  assert.deepStrictEqual(
    mcpAuthHeaders(new URL('https://tools.example.com/sse'), ENV),
    { Authorization: 'Bearer tok-1' },
  );
});

test('host matching is exact and case-insensitive', () => {
  assert.deepStrictEqual(
    mcpAuthHeaders(new URL('https://TOOLS.example.com/sse'), ENV),
    { Authorization: 'Bearer tok-1' },
  );
  assert.deepStrictEqual(mcpAuthHeaders(new URL('https://evil-tools.example.com/sse'), ENV), {});
  assert.deepStrictEqual(mcpAuthHeaders(new URL('https://tools.example.com.evil.net/sse'), ENV), {});
});

test('plain http never carries a token', () => {
  assert.deepStrictEqual(mcpAuthHeaders(new URL('http://tools.example.com/sse'), ENV), {});
});

test('an unset, malformed or non-object value sends nothing', () => {
  const url = new URL('https://tools.example.com/sse');
  assert.deepStrictEqual(mcpAuthHeaders(url, {} as NodeJS.ProcessEnv), {});
  assert.deepStrictEqual(mcpAuthHeaders(url, env('not json')), {});
  assert.deepStrictEqual(mcpAuthHeaders(url, env('["tok-1"]')), {});
  assert.deepStrictEqual(mcpAuthHeaders(url, env({ 'tools.example.com': 42 })), {});
  assert.deepStrictEqual(mcpAuthHeaders(url, env({ 'tools.example.com': '' })), {});
});

test('inherited keys are not tokens', () => {
  assert.deepStrictEqual(mcpAuthHeaders(new URL('https://constructor/sse'), ENV), {});
});
