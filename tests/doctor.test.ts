/**
 * tests/doctor.test.ts — the onboarding report, offline, against the real
 * starter pack. No network, no keys: the env is controlled per test.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  declaredTierOf,
  listSyndicateFiles,
  renderDoctor,
  runCommandFor,
  runDoctor,
  tierOf,
} from '../lib/doctor.ts';

const AGENTS = path.join(process.cwd(), 'config', 'agents');
const ENV_KEYS = [
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'MODEL_GATEWAY',
  'MODEL_GATEWAY_API_KEY',
];

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('listSyndicateFiles sees the root and examples/, never the schema or evals/', () => {
  const files = listSyndicateFiles(AGENTS);
  assert.ok(files.includes('examples/council.yaml'));
  assert.ok(!files.some((f) => f.includes('syndicateSchema')));
  assert.ok(!files.some((f) => f.startsWith('evals/')));
});

test('an empty env: every example is blocked or ready-local, and the Gemini key unlocks the most', () => {
  withEnv({}, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const examples = result.syndicates.filter((s) => s.file.startsWith('examples/'));
    assert.ok(examples.length >= 16, `expected the starter pack, saw ${examples.length}`);
    for (const s of examples) {
      assert.ok(
        s.verdict.state === 'blocked' || s.verdict.state === 'ready-local',
        `${s.file} should not be ready with no keys, was ${s.verdict.state}`,
      );
      assert.equal(s.error, undefined, `${s.file}: ${s.error}`);
    }
    const local = examples.filter((s) => s.verdict.state === 'ready-local').map((s) => s.file);
    assert.deepEqual(local.sort(), ['examples/assistant.yaml', 'examples/council.yaml', 'examples/tutor.yaml']);
    assert.equal(result.unlocks[0]?.env, 'GOOGLE_GENAI_API_KEY');
    assert.ok(result.unlocks[0].syndicates.length >= 12);
    assert.equal(result.gateway, null);
  });
});

test('the Gemini key alone readies every Gemini-tier example', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'g' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const examples = result.syndicates.filter((s) => s.file.startsWith('examples/'));
    for (const s of examples) {
      if (s.tier === 'gemini') assert.equal(s.verdict.state, 'ready', s.file);
      if (s.tier === 'keyless') assert.equal(s.verdict.state, 'ready-local', s.file);
    }
    const zoo = examples.find((s) => s.file === 'examples/model_zoo.yaml')!;
    assert.equal(zoo.tier, 'multi-provider');
    assert.equal(zoo.verdict.state, 'blocked');
    assert.match(zoo.verdict.detail, /ANTHROPIC_API_KEY/);
  });
});

test('a gateway key alone readies every cloud example via the gateway and names what is lost', () => {
  withEnv({ MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    assert.equal(result.counts.blocked, 0);
    assert.equal(result.gateway?.usable, true);
    const ares = result.syndicates.find((s) => s.file === 'examples/ares.yaml')!;
    assert.equal(ares.verdict.state, 'via-gateway');
    assert.match(ares.verdict.detail, /google_search lost/);
  });
});

test('adding the Gemini key beside the gateway moves Gemini agents back to direct with grounding', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'g', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'k' }, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    const ares = result.syndicates.find((s) => s.file === 'examples/ares.yaml')!;
    assert.equal(ares.verdict.state, 'ready');
    assert.ok(ares.rows.every((r) => r.report.transport === 'direct'));
    const zoo = result.syndicates.find((s) => s.file === 'examples/model_zoo.yaml')!;
    assert.equal(zoo.verdict.state, 'via-gateway');
  });
});

test('declared tiers match the models in every example', () => {
  withEnv({}, () => {
    const result = runDoctor({ agentsDir: AGENTS });
    for (const s of result.syndicates.filter((s) => s.file.startsWith('examples/'))) {
      assert.ok(s.declaredTier, `${s.file} has no "# tier:" header`);
      assert.equal(s.declaredTier, s.tier, `${s.file} header says ${s.declaredTier}, models say ${s.tier}`);
    }
  });
});

test('nested yaml_reference syndicates are walked and named under their parent', () => {
  // A fixture of its own: the public mirror ships no nested syndicate, and
  // the doctor must behave the same in both repos.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-nested-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'child.yaml'),
      [
        'syndicate_name: "Child"',
        'orchestrator:',
        '  name: "Kid"',
        '  model: "ollama/qwen3:8b"',
        '  instruction: "hi"',
        'subagents: []',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'parent.yaml'),
      [
        'syndicate_name: "Parent"',
        'orchestrator:',
        '  name: "Boss"',
        '  model: "gemini-3.8-flash"',
        '  instruction: "hi"',
        '  tools: ["web_search"]',
        'subagents:',
        '  - name: "child"',
        '    description: "the nested team"',
        '    yaml_reference: "child.yaml"',
        '',
      ].join('\n'),
    );
    withEnv({ GOOGLE_GENAI_API_KEY: 'g' }, () => {
      const result = runDoctor({ agentsDir: dir });
      const parent = result.syndicates.find((s) => s.file === 'parent.yaml')!;
      assert.deepEqual(
        parent.rows.map((r) => r.agent),
        ['Boss', 'child › Kid'],
      );
      assert.equal(parent.tier, 'multi-provider');
      assert.equal(parent.verdict.state, 'ready');
      assert.deepEqual(parent.rows[0].report.native, ['web_search']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tierOf, declaredTierOf and runCommandFor', () => {
  assert.equal(tierOf([]), 'gemini');
  assert.equal(declaredTierOf(path.join(AGENTS, 'examples', 'council.yaml')), 'keyless');
  assert.equal(
    runCommandFor('examples/council.yaml', { 'syndicate:council': 'node x --syndicate council' }),
    'npm run syndicate:council',
  );
  assert.equal(runCommandFor('examples/style_council.yaml', { 'syndicate:council': 'node x --syndicate council' }), undefined);
});

test('renderDoctor never prints a key value', () => {
  withEnv({ GOOGLE_GENAI_API_KEY: 'sk-very-secret-value', MODEL_GATEWAY: 'vercel', MODEL_GATEWAY_API_KEY: 'gw-secret' }, () => {
    const text = renderDoctor(runDoctor({ agentsDir: AGENTS }));
    assert.ok(!text.includes('sk-very-secret-value'));
    assert.ok(!text.includes('gw-secret'));
    assert.match(text, /ready/);
    assert.match(text, /Read-only/);
  });
});
