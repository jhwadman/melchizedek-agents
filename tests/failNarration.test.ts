/**
 * Failed-task narration — offline. A failed turn's reason travels to the
 * surface through the task's status message, and the Discord client renders
 * it verbatim (2026-08-27: a Gemini 503 "high demand" reached the user as
 * "Agent task TASK_STATE_FAILED: Unknown error"). describeTurnError is the
 * one seam that turns a provider error into that user-facing line.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { describeTurnError } from '../scripts/a2a_server.ts';

test('a plain provider message passes through verbatim', () => {
  const msg = 'This model is currently experiencing high demand. Please try again later.';
  assert.strictEqual(describeTurnError({ code: '503', message: msg }), msg);
});

test('a Gemini ApiError JSON blob yields its inner message, not the blob', () => {
  const blob = JSON.stringify({ error: { code: 503, message: 'High demand. Try later.', status: 'UNAVAILABLE' } });
  assert.strictEqual(describeTurnError({ code: '503', message: blob }), 'High demand. Try later.');
});

test('an empty message keeps the pointer at the server logs', () => {
  assert.match(describeTurnError({ code: 'ERROR', message: '' }), /server logs/);
});

test('malformed JSON and oversized messages degrade safely', () => {
  assert.strictEqual(describeTurnError({ code: 'X', message: '{not json' }), '{not json');
  const long = describeTurnError({ code: 'X', message: 'a'.repeat(500) });
  assert.ok(long.length <= 300 && long.endsWith('...'));
});
