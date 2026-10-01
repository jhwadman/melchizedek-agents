/**
 * tests/syndicateSchema.test.ts — the syndicate YAML contract, offline.
 *
 * Every shipped file must pass it; every mistake the audit reproduced (a
 * missing key, a misspelt key, a bad enum) must fail with the key path and,
 * where there is one, the key the author meant; and the JSON Schema an
 * editor reads must be the one the code generates.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';

import { loadSyndicate } from '../lib/loadSyndicate.ts';
import { runDoctor } from '../lib/doctor.ts';
import {
  SyndicateValidationError,
  suggest,
  syndicateJsonSchema,
  validateSyndicateConfig,
} from '../lib/syndicateSchema.ts';

const AGENTS = path.join(process.cwd(), 'config', 'agents');

const shipped = fs
  .readdirSync(AGENTS, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.yaml'))
  .sort();

/** A minimal valid syndicate; each case breaks one thing. */
function base(): Record<string, any> {
  return {
    syndicate_name: 'Test',
    memory_system: 'internal-only',
    orchestrator: { name: 'Lead', model: 'gemini-3.1-flash-lite', instruction: 'Lead.' },
    subagents: [
      { name: 'Helper', description: 'Helps.', model: 'gemini-3.1-flash-lite', instruction: 'Help.' },
    ],
  };
}

function problemsOf(raw: unknown): string[] {
  try {
    validateSyndicateConfig(raw, 'config/agents/x.yaml');
  } catch (err) {
    assert.ok(err instanceof SyndicateValidationError, `not a validation error: ${err}`);
    return err.problems;
  }
  return [];
}

function assertProblem(problems: string[], expected: RegExp): void {
  assert.ok(
    problems.some((p) => expected.test(p)),
    `expected a problem matching ${expected}, got:\n  ${problems.join('\n  ')}`,
  );
}

test('every shipped YAML passes the schema', async (t) => {
  assert.ok(shipped.length > 0);
  for (const file of shipped) {
    await t.test(file, () => {
      // Through the loader (post-interpolation) and on the raw parse: both
      // must accept what ships, or an editor and a run would disagree.
      assert.doesNotThrow(() => loadSyndicate(file));
      const raw = parse(fs.readFileSync(path.join(AGENTS, file), 'utf-8'));
      assert.deepEqual(problemsOf(raw), []);
    });
  }
});

test('the minimal fixture is valid', () => {
  assert.deepEqual(problemsOf(base()), []);
});

test('no subagents key: a single-agent syndicate, normalized to an empty team', () => {
  // Registry rows written before the schema omit the key; they must still load.
  const raw = base();
  delete raw.subagents;
  const cfg = validateSyndicateConfig(raw, 'config/agents/x.yaml');
  assert.deepEqual(cfg.subagents, []);
});

test('subagents of the wrong type is still an error', () => {
  const raw = base();
  raw.subagents = 'Helper';
  assertProblem(problemsOf(raw), /^config\/agents\/x\.yaml: subagents — /);
});

test('orchestator typo: the unknown key, its suggestion, then the missing key', () => {
  const raw = base();
  raw.orchestator = raw.orchestrator;
  delete raw.orchestrator;
  const problems = problemsOf(raw);
  assert.equal(problems[0], 'config/agents/x.yaml: orchestator — unknown key (did you mean "orchestrator"?)');
  assertProblem(problems, /: orchestrator — required$/);
});

test('instuction and modle on a subagent are named with their path and suggestion', () => {
  const raw = base();
  raw.subagents.push({ name: 'Other', description: 'd', modle: 'gemini-x', instuction: 'Do.' });
  const problems = problemsOf(raw);
  assertProblem(problems, /^config\/agents\/x\.yaml: subagents\[1\]\.modle — unknown key \(did you mean "model"\?\)$/);
  assertProblem(problems, /subagents\[1\]\.instuction — unknown key \(did you mean "instruction"\?\)$/);
  assertProblem(problems, /subagents\[1\]\.instruction — required/);
});

test('instuction and modle on the orchestrator', () => {
  const raw = base();
  raw.orchestrator = { name: 'Lead', modle: 'gemini-x', instuction: 'Lead.' };
  const problems = problemsOf(raw);
  assertProblem(problems, /orchestrator\.modle — unknown key \(did you mean "model"\?\)/);
  assertProblem(problems, /orchestrator\.instuction — unknown key \(did you mean "instruction"\?\)/);
  assertProblem(problems, /orchestrator\.model — required/);
  assertProblem(problems, /orchestrator\.instruction — required/);
});

test('max_stepz is unknown, and max_steps must be a positive integer', () => {
  const typo = base();
  typo.max_stepz = 10;
  assertProblem(problemsOf(typo), /: max_stepz — unknown key \(did you mean "max_steps"\?\)$/);

  for (const bad of [0, -3, 2.5, 'ten']) {
    const raw = base();
    raw.max_steps = bad;
    assertProblem(problemsOf(raw), /: max_steps — /);
  }
});

test('memory_system is an enum, with a suggestion for the near miss', () => {
  const raw = base();
  raw.memory_system = 'internl-only';
  assertProblem(
    problemsOf(raw),
    /: memory_system — must be one of internal-only \| session-only \| long-term \(got "internl-only" — did you mean "internal-only"\?\)$/,
  );
});

test('every problem is reported in one error, not just the first', () => {
  const raw = base();
  raw.max_stepz = 1;
  raw.memory_system = 'forever';
  raw.subagents[0].modle = 'x';
  assert.ok(problemsOf(raw).length >= 3);
});

test('dispatch.default_route must name a declared subagent', () => {
  const raw = base();
  raw.dispatch = { default_route: 'Helpr' };
  assertProblem(
    problemsOf(raw),
    /: dispatch\.default_route — "Helpr" is not a declared subagent \(did you mean "Helper"\?\)$/,
  );
  // The runtime matches routes ignoring case and punctuation; so does this.
  raw.dispatch = { default_route: 'helper' };
  assert.deepEqual(problemsOf(raw), []);
});

test('variables are a map of string | number | boolean', () => {
  const raw = base();
  raw.variables = { a: 'x', b: 2, c: true };
  assert.deepEqual(problemsOf(raw), []);
  raw.variables = { nested: { no: 1 } };
  assertProblem(problemsOf(raw), /: variables\.nested — /);
});

test('{{tokens}} inside values pass: they are strings', () => {
  const raw = base();
  raw.orchestrator.instruction = 'Focus on {{focus_area}} as of {{current_date}}.';
  raw.orchestrator.model = '{{model_id}}';
  raw.subagents.push({ name: 'Remote', description: 'd', a2a_agent_url: '{{remote_url}}' });
  assert.deepEqual(problemsOf(raw), []);
});

test('an a2a_agent_url subagent needs no model or instruction', () => {
  const raw = base();
  raw.subagents.push({ name: 'Remote', description: 'A remote agent.', a2a_agent_url: 'https://agents.example.com' });
  assert.deepEqual(problemsOf(raw), []);
});

test('a yaml_reference subagent needs no model or instruction', () => {
  const raw = base();
  raw.subagents.push({ name: 'Nested', description: 'A nested team.', yaml_reference: 'research_desk.yaml' });
  assert.deepEqual(problemsOf(raw), []);
});

test('a2a_agent_url cannot be combined with yaml_reference, and must be http(s)', () => {
  const raw = base();
  raw.subagents.push({
    name: 'Both',
    description: 'd',
    yaml_reference: 'research_desk.yaml',
    a2a_agent_url: 'https://agents.example.com',
  });
  assertProblem(problemsOf(raw), /subagents\[1\]\.a2a_agent_url — cannot be combined with yaml_reference/);

  const ftp = base();
  ftp.subagents.push({ name: 'Ftp', description: 'd', a2a_agent_url: 'ftp://agents.example.com' });
  assertProblem(problemsOf(ftp), /subagents\[1\]\.a2a_agent_url — must be an http\(s\) URL/);
});

test('agent names follow ADK: an identifier, not "user", unique in the file', () => {
  const raw = base();
  raw.subagents[0].name = 'my helper';
  assertProblem(problemsOf(raw), /subagents\[0\]\.name — must be a valid identifier/);
  raw.subagents[0].name = 'user';
  assertProblem(problemsOf(raw), /subagents\[0\]\.name — 'user' is reserved/);
  raw.subagents[0].name = 'Lead';
  assertProblem(problemsOf(raw), /subagents\[0\]\.name — duplicate agent name "Lead"/);
});

test('a subagent needs a description; generateContentConfig and outputSchema stay permissive', () => {
  const raw = base();
  delete raw.subagents[0].description;
  assertProblem(problemsOf(raw), /subagents\[0\]\.description — required/);

  const loose = base();
  loose.orchestrator.generateContentConfig = { toolConfig: { anything: true }, thinkingConfig: { thinkingBudget: 0, x: 1 } };
  loose.orchestrator.outputSchema = { type: 'object', properties: { route: { type: 'string' } } };
  assert.deepEqual(problemsOf(loose), []);

  const typed = base();
  typed.orchestrator.generateContentConfig = { temperature: 'hot' };
  assertProblem(problemsOf(typed), /orchestrator\.generateContentConfig\.temperature — expected number/);
});

test('a non-mapping document fails with a pointed message', () => {
  assertProblem(problemsOf(null), /\(root\) — expected a mapping/);
  assertProblem(problemsOf(['a']), /\(root\) — expected a mapping/);
});

test('the legacy options block is rejected by name', () => {
  const raw = base();
  raw.orchestrator.options = { temperature: 1 };
  assertProblem(problemsOf(raw), /orchestrator\.options — unknown key/);
});

test('suggest: transpositions, case and snake/camel drift; nothing for a stranger', () => {
  assert.equal(suggest('modle', ['model', 'name']), 'model');
  assert.equal(suggest('output_key', ['outputKey']), 'outputKey');
  assert.equal(suggest('Model', ['model']), 'model');
  assert.equal(suggest('banana', ['model', 'instruction']), undefined);
  assert.equal(suggest('c', ['a']), undefined);
});

test('the loader runs the validator and names the file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melch-schema-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'broken.yaml'),
      'syndicate_name: Broken\norchestrator:\n  name: Lead\n  modle: gemini-x\n  instruction: hi\n',
    );
    assert.throws(
      () => loadSyndicate('broken.yaml', { agentsDir: dir }),
      (err: Error) => err instanceof SyndicateValidationError && /broken\.yaml: orchestrator\.modle — unknown key/.test(err.message),
    );
    // A full-token binding is validated as the value it resolved to.
    fs.writeFileSync(
      path.join(dir, 'bound.yaml'),
      'syndicate_name: Bound\nmax_steps: "{{steps}}"\nvariables:\n  steps: 8\norchestrator:\n  name: Lead\n  model: gemini-x\n  instruction: hi\nsubagents: []\n',
    );
    assert.equal(loadSyndicate('bound.yaml', { agentsDir: dir }).max_steps, 8);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: an invalid syndicate is blocked as invalid, never ready', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'melch-doctor-invalid-'));
  const saved = process.env.GOOGLE_GENAI_API_KEY;
  process.env.GOOGLE_GENAI_API_KEY = 'g';
  try {
    fs.writeFileSync(
      path.join(dir, 'typo.yaml'),
      'syndicate_name: Typo\nmemory_system: internl-only\norchestrator:\n  name: Lead\n  model: gemini-x\n  instruction: hi\nsubagents: []\n',
    );
    fs.writeFileSync(
      path.join(dir, 'parent.yaml'),
      'syndicate_name: Parent\norchestrator:\n  name: Boss\n  model: gemini-x\n  instruction: hi\nsubagents:\n  - name: kid\n    description: d\n    yaml_reference: typo.yaml\n',
    );
    const result = runDoctor({ agentsDir: dir });
    const typo = result.syndicates.find((s) => s.file === 'typo.yaml')!;
    assert.equal(typo.verdict.state, 'blocked');
    assert.match(typo.verdict.detail, /^invalid — memory_system — must be one of/);
    const parent = result.syndicates.find((s) => s.file === 'parent.yaml')!;
    assert.equal(parent.verdict.state, 'blocked');
    assert.match(parent.verdict.detail, /^invalid — nested typo\.yaml: memory_system/);
    assert.equal(result.counts.ready, 0);
    assert.equal(result.counts.blocked, 2);
  } finally {
    if (saved === undefined) delete process.env.GOOGLE_GENAI_API_KEY;
    else process.env.GOOGLE_GENAI_API_KEY = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('config/agents/syndicate.schema.json is the generated schema (npm run schema:gen)', () => {
  const committed = fs.readFileSync(path.join(AGENTS, 'syndicate.schema.json'), 'utf-8');
  assert.equal(committed, JSON.stringify(syndicateJsonSchema(), null, 2) + '\n');
});

test('the JSON Schema is strict where the validator is', () => {
  const schema = syndicateJsonSchema() as any;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.sort(), ['orchestrator', 'syndicate_name']);
  assert.equal(schema.properties.orchestrator.additionalProperties, false);
  assert.deepEqual(schema.properties.memory_system.enum, ['internal-only', 'session-only', 'long-term']);
  const sub = schema.properties.subagents.items;
  assert.equal(sub.additionalProperties, false);
  assert.ok(sub.properties.a2a_agent_url);
  assert.ok(Array.isArray(sub.anyOf));
});
