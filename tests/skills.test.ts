/**
 * The agent-skills suite installer (lib/skills.ts, the `melchizedek-skills`
 * bin): target resolution, copying, the no-clobber rule, --only, and the
 * suite's own SKILL.md files being well-formed. Offline; temp dirs only.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SKILL_TARGETS, destinationsFor, installSkills, listSkills, resolveSkillsSource } from '../lib/skills.ts';

function fakeSuite(): string {
  const src = mkdtempSync(join(tmpdir(), 'melch-skills-src-'));
  for (const name of ['melchizedek', 'melchizedek-author']) {
    mkdirSync(join(src, name, 'templates'), { recursive: true });
    writeFileSync(join(src, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} does a thing.\n---\n# ${name}\n`);
    writeFileSync(join(src, name, 'templates', 'x.md'), 'template');
  }
  writeFileSync(join(src, 'README.md'), 'not a skill');
  return src;
}

test('listSkills reads name and description from frontmatter and ignores loose files', () => {
  const src = fakeSuite();
  try {
    const skills = listSkills(src);
    assert.deepStrictEqual(skills.map((s) => s.name), ['melchizedek', 'melchizedek-author']);
    assert.strictEqual(skills[0].description, 'melchizedek does a thing.');
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
});

test('destinationsFor: defaults, all targets deduplicated, global vs project, explicit dir', () => {
  const root = '/proj';
  const home = '/home/u';
  assert.deepStrictEqual(destinationsFor({ projectRoot: root }), ['/proj/.claude/skills', '/proj/.agents/skills']);
  const all = destinationsFor({ projectRoot: root, targets: Object.keys(SKILL_TARGETS) as any });
  // codex and agents share .agents/skills at project level → one entry
  assert.strictEqual(new Set(all).size, all.length);
  assert.ok(all.includes('/proj/.cursor/skills') && all.includes('/proj/.opencode/skills') && all.includes('/proj/.gemini/skills'));
  assert.deepStrictEqual(destinationsFor({ global: true, home, targets: ['codex', 'opencode'] }), [
    '/home/u/.codex/skills',
    '/home/u/.config/opencode/skills',
  ]);
  assert.deepStrictEqual(destinationsFor({ dir: '/elsewhere', targets: ['cursor'] }), ['/elsewhere']);
  assert.throws(() => destinationsFor({ targets: ['vim' as any] }), /unknown target/);
});

test('installSkills copies every file, reports unchanged on rerun, refuses to clobber without force', () => {
  const src = fakeSuite();
  const proj = mkdtempSync(join(tmpdir(), 'melch-skills-proj-'));
  try {
    const [claude, agents] = installSkills({ source: src, projectRoot: proj });
    assert.strictEqual(claude.destination, join(proj, '.claude/skills'));
    // listSkills sorts by name, so the bare `melchizedek` precedes `melchizedek-author`.
    assert.deepStrictEqual(claude.written, [
      'melchizedek/SKILL.md',
      'melchizedek/templates/x.md',
      'melchizedek-author/SKILL.md',
      'melchizedek-author/templates/x.md',
    ]);
    assert.ok(existsSync(join(agents.destination, 'melchizedek', 'SKILL.md')));
    assert.ok(!existsSync(join(proj, '.claude/skills/README.md')), 'loose files are not skills');

    const again = installSkills({ source: src, projectRoot: proj })[0];
    assert.deepStrictEqual(again.written, []);
    assert.strictEqual(again.unchanged.length, 4);

    writeFileSync(join(proj, '.claude/skills/melchizedek/SKILL.md'), 'edited locally');
    const clash = installSkills({ source: src, projectRoot: proj, targets: ['claude'] })[0];
    assert.deepStrictEqual(clash.skipped, ['melchizedek/SKILL.md']);
    assert.strictEqual(readFileSync(join(proj, '.claude/skills/melchizedek/SKILL.md'), 'utf-8'), 'edited locally');

    const forced = installSkills({ source: src, projectRoot: proj, targets: ['claude'], force: true })[0];
    assert.deepStrictEqual(forced.written, ['melchizedek/SKILL.md']);

    const dry = installSkills({ source: src, dir: join(proj, 'dry'), dryRun: true })[0];
    assert.strictEqual(dry.written.length, 4);
    assert.ok(!existsSync(join(proj, 'dry')));

    const only = installSkills({ source: src, dir: join(proj, 'only'), only: ['melchizedek-author'] })[0];
    assert.deepStrictEqual(only.written, ['melchizedek-author/SKILL.md', 'melchizedek-author/templates/x.md']);
    assert.throws(() => installSkills({ source: src, dir: join(proj, 'x'), only: ['nope'] }), /unknown skill/);
  } finally {
    rmSync(src, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test('the shipped suite resolves and every skill has frontmatter that matches its directory', () => {
  const source = resolveSkillsSource();
  const skills = listSkills(source);
  assert.ok(skills.length >= 6, `expected the six-skill suite, found ${skills.length}`);
  for (const s of skills) {
    assert.match(s.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${s.name}: name must be lowercase with single hyphens`);
    assert.strictEqual(s.dir.endsWith(`/${s.name}`), true, `${s.name}: frontmatter name must equal its directory`);
    assert.ok(s.description.length > 20 && s.description.length <= 1024, `${s.name}: description length`);
  }
});
