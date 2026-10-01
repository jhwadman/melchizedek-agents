/**
 * Structured-output schema invariants — fully offline.
 *
 * A judge rubric is only usable if the model returns the fields under the
 * names the harness declared. OpenAI-style "strict" structured output
 * enforces that at the API, but only for a schema where every object
 * forbids extra properties and requires all of its own. This pins the
 * transform that produces it.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { toLowercaseJsonSchema, toStrictJsonSchema } from '../lib/models/schemaNormalize.ts';

const RUBRIC = {
  type: 'OBJECT',
  properties: {
    correctness: { type: 'INTEGER', description: 'x' },
    ok: { type: 'BOOLEAN' },
    grade: { type: 'STRING', enum: ['a', 'b'] },
    issues: { type: 'ARRAY', items: { type: 'STRING' } },
    nested: { type: 'OBJECT', properties: { why: { type: 'STRING' } } },
  },
  required: ['correctness', 'rationale'],
};

test('strict schema forbids extras and requires every property at every level', () => {
  const strict = toStrictJsonSchema(RUBRIC) as any;
  assert.strictEqual(strict.type, 'object');
  assert.strictEqual(strict.additionalProperties, false);
  assert.deepStrictEqual(strict.required, ['correctness', 'ok', 'grade', 'issues', 'nested']);
  assert.strictEqual(strict.properties.issues.items.type, 'string');
  assert.strictEqual(strict.properties.nested.additionalProperties, false);
  assert.deepStrictEqual(strict.properties.nested.required, ['why']);
  assert.deepStrictEqual(strict.properties.grade.enum, ['a', 'b'], 'enum values keep their casing');
});

test('the lowercase transform is untouched by the strict one', () => {
  const lower = toLowercaseJsonSchema(RUBRIC) as any;
  assert.deepStrictEqual(lower.required, ['correctness', 'rationale']);
  assert.strictEqual(lower.additionalProperties, undefined);
  // The input is never mutated.
  assert.strictEqual(RUBRIC.type, 'OBJECT');
  assert.strictEqual((RUBRIC.properties.nested as any).additionalProperties, undefined);
});
