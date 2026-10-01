/**
 * `cp .env.example .env` must be safe. Before 2026-10 the template shipped
 * `your_..._here` values that the code read as real: the default quickstart
 * crashed in supabase-js, the doctor reported every provider funded, and the
 * example bearer secret became a live one.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPlaceholderValue, loadEnv, parseEnvFile } from '../lib/loadEnv.ts';
import { providerKeyPresent } from '../lib/models/providerMap.ts';
import { hasSupabaseCredentials } from '../lib/persistence/supabaseProvider.ts';

// The overlay's template exists only in the source repo; in the public repo
// it IS the root .env.example.
const TEMPLATES = ['.env.example', 'scripts/export-public/overlay/.env.example'].filter((p) => existsSync(p));

const SENSITIVE = [
  'GOOGLE_GENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'XAI_API_KEY',
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'A2A_SERVER_SECRET', 'MODEL_GATEWAY_API_KEY',
];

function withCleanEnv(fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of SENSITIVE) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    fn();
  } finally {
    for (const k of SENSITIVE) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

for (const template of TEMPLATES) {
  test(`${template}: a verbatim copy funds no provider, no database and no secret`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'melch-env-'));
    copyFileSync(template, join(dir, '.env'));
    const cwd = process.cwd();
    withCleanEnv(() => {
      process.chdir(dir);
      try {
        loadEnv();
        for (const p of ['gemini', 'anthropic', 'openai', 'xai'] as const) {
          assert.strictEqual(providerKeyPresent(p), false, `${p} must not look funded`);
        }
        assert.strictEqual(hasSupabaseCredentials(), false);
        assert.ok(!process.env.A2A_SERVER_SECRET, 'no secret from the template');
      } finally {
        process.chdir(cwd);
      }
    });
  });

  test(`${template}: carries no placeholder values at all`, () => {
    for (const [key, value] of parseEnvFile(readFileSync(template, 'utf-8'))) {
      assert.ok(!isPlaceholderValue(value), `${key}=${value} is a placeholder`);
    }
  });
}

test('the parser strips quotes, export prefixes and inline comments', () => {
  const parsed = parseEnvFile([
    'export A=1',
    'B="two words"',
    "C='single'",
    'D=plain # trailing comment',
    'E=has#hash',
    '# F=commented',
    'bad line',
  ].join('\n'));
  assert.deepStrictEqual(Object.fromEntries(parsed), { A: '1', B: 'two words', C: 'single', D: 'plain', E: 'has#hash' });
});

test('placeholders are skipped even when a real file has them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'melch-env-'));
  writeFileSync(join(dir, '.env'), 'ANTHROPIC_API_KEY=your_anthropic_api_key_here\nOPENAI_API_KEY=<paste-here>\n');
  const cwd = process.cwd();
  withCleanEnv(() => {
    process.chdir(dir);
    try {
      loadEnv();
      assert.strictEqual(process.env.ANTHROPIC_API_KEY, undefined);
      assert.strictEqual(process.env.OPENAI_API_KEY, undefined);
    } finally {
      process.chdir(cwd);
    }
  });
});

test('a non-URL SUPABASE_URL is not treated as credentials', () => {
  withCleanEnv(() => {
    process.env.SUPABASE_URL = 'my-project';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb-test-not-a-real-key-0123456789';
    assert.strictEqual(hasSupabaseCredentials(), false);
    process.env.SUPABASE_URL = 'https://abc.supabase.co';
    assert.strictEqual(hasSupabaseCredentials(), true);
  });
});
