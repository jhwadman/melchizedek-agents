#!/usr/bin/env node
/**
 * scripts/init.ts — the `melchizedek-init` bin and `npm run init`.
 *
 * Starts a project from a shipped template or example in one command, so a
 * first run is not "find a YAML inside node_modules and copy it by hand":
 *
 *   npx melchizedek-init                              # the conversational template
 *   npx melchizedek-init --template support_triage    # any template or example name
 *   npx melchizedek-init --template research_brief --as brief
 *   npx melchizedek-init --list
 *
 * It writes `config/agents/<name>.yaml` (and any syndicate the template nests
 * through `yaml_reference`), points the file at the published JSON Schema so
 * an editor validates it as you type, gives a long-term-memory syndicate its
 * own `memory_namespace` (ADR 0020: two copies of one template must not share
 * memory in one database), creates `.env` from the template when there is
 * none, and prints the commands to run next. It never overwrites a file
 * unless --force is given.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

import { assignMemoryNamespace } from '../lib/memory/namespace.ts';

const SHIPPED_DIRS = ['templates', 'examples'] as const;

/** The package (or clone) root this script ships in. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'config', 'agents', 'syndicate.schema.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('config/agents/ not found next to this package');
}

/** Shipped syndicate names, by directory. */
export function shippedSyndicates(root = packageRoot()): Record<(typeof SHIPPED_DIRS)[number], string[]> {
  const list = (dir: string) =>
    existsSync(join(root, 'config', 'agents', dir))
      ? readdirSync(join(root, 'config', 'agents', dir)).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -5)).sort()
      : [];
  return { templates: list('templates'), examples: list('examples') };
}

function findShipped(root: string, name: string): string | undefined {
  for (const dir of SHIPPED_DIRS) {
    const p = join(root, 'config', 'agents', dir, `${name}.yaml`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface InitOptions {
  template: string;
  /** File name for the copy, without .yaml. Default: the template's name. */
  as?: string;
  /** Project directory. Default: the current directory. */
  cwd?: string;
  force?: boolean;
  /** Package root to copy from (tests). */
  root?: string;
  random?: (n: number) => Buffer;
}

export interface InitResult {
  written: string[];
  skipped: string[];
  namespace?: string;
  envCreated: boolean;
}

/** Copy a shipped syndicate (and what it nests) into a project. */
export function initProject(opts: InitOptions): InitResult {
  const root = opts.root ?? packageRoot();
  const cwd = resolve(opts.cwd ?? process.cwd());
  const agentsDir = join(cwd, 'config', 'agents');
  const schemaPath = join(root, 'config', 'agents', 'syndicate.schema.json');
  const result: InitResult = { written: [], skipped: [], envCreated: false };
  mkdirSync(agentsDir, { recursive: true });

  const copy = (name: string, targetName: string, top: boolean) => {
    const source = findShipped(root, name);
    if (!source) throw new Error(`No template or example named '${name}'. Run with --list to see them.`);
    const target = join(agentsDir, `${targetName}.yaml`);
    if (existsSync(target) && !opts.force) {
      result.skipped.push(relative(cwd, target));
      return;
    }
    const text = readFileSync(source, 'utf-8');
    const modeline = `# yaml-language-server: $schema=${relative(agentsDir, schemaPath)}`;
    writeFileSync(target, text.startsWith('# yaml-language-server:') ? text : `${modeline}\n${text}`);
    result.written.push(relative(cwd, target));
    if (top) {
      const cfg = parse(text) ?? {};
      if (cfg.memory_system === 'long-term') {
        // A copy gets its OWN namespace, even if the shipped file declares an
        // example one: two copies must not share memory in one database.
        const withoutShipped = readFileSync(target, 'utf-8').replace(/^memory_namespace:.*\n/m, '');
        writeFileSync(target, withoutShipped);
        result.namespace = assignMemoryNamespace(target, opts.random).namespace;
      }
    }
    // Nested syndicates resolve by name from the same directory.
    const nested = ((parse(text) ?? {}).subagents ?? [])
      .map((s: any) => s?.yaml_reference)
      .filter((r: unknown): r is string => typeof r === 'string');
    for (const ref of nested) copy(ref.replace(/\.ya?ml$/, ''), ref.replace(/\.ya?ml$/, ''), false);
  };
  copy(opts.template, opts.as ?? opts.template, true);

  const envTarget = join(cwd, '.env');
  const envSource = join(root, '.env.example');
  if (!existsSync(envTarget) && existsSync(envSource)) {
    copyFileSync(envSource, envTarget);
    result.envCreated = true;
  }
  return result;
}

function main(): void {
  const argv = process.argv.slice(2).filter((a) => a !== '--');
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: melchizedek-init [--template <name>] [--as <file name>] [--force] [--list]');
    return;
  }
  if (argv.includes('--list')) {
    const { templates, examples } = shippedSyndicates();
    console.log(`Templates (production starting points):\n  ${templates.join('\n  ')}\n`);
    console.log(`Examples (the starter pack the curriculum teaches):\n  ${examples.join('\n  ')}`);
    return;
  }
  const template = flag('template') ?? 'conversational';
  const name = flag('as') ?? template;
  const result = initProject({ template, as: name, force: argv.includes('--force') });

  for (const f of result.written) console.log(`✓ wrote ${f}`);
  for (const f of result.skipped) console.log(`· kept ${f} (exists; --force to overwrite)`);
  if (result.namespace) console.log(`✓ memory_namespace: ${result.namespace}`);
  if (result.envCreated) console.log('✓ created .env from the template — add the keys your models need');
  const inPackage = fileURLToPath(import.meta.url).includes(`${'node_modules'}`);
  const run = (bin: string, script: string) => (inPackage ? `npx ${bin}` : `npm run ${script} --`);
  console.log(`
Next:
  ${run('melchizedek-doctor', 'doctor')}                       which keys ${name}.yaml needs, and whether it is ready
  ${run('melchizedek-chat', 'chat:syndicate')} --syndicate ${name}   talk to it
  ${run('melchizedek-serve', 'start:a2a')} ${name}.yaml            serve it over A2A`);
}

const invokedAsMain = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedAsMain) {
  try {
    main();
  } catch (err: unknown) {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
