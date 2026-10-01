/**
 * scripts/wiki/build.ts — build melchizedek's own knowledge bundle from repo truth.
 *
 * WHY this file exists:
 *   The wiki's structural layer must never be typed by hand: syndicate
 *   docs derive from config/agents/*.yaml, tool docs from the tool
 *   contracts, the schema doc from db/*.sql, provider docs from the model
 *   registry. This script reads those sources and upserts the derived
 *   documents through lib/wiki/builder.ts — machine-owned sections
 *   refreshed, prose (human or LLM) preserved. Re-run it whenever repo
 *   truth changes; nothing it does is destructive.
 *
 *   A deployment's private additions (private syndicates, private tools,
 *   the names a public document may not contain) live in build.private.ts
 *   beside this file, loaded only when it exists; without it the build
 *   documents public knowledge only.
 *
 * RUN:
 *   npm run wiki:build            structural build + index refresh + lint
 *   npm run wiki:build -- --fill  …then LLM gap-fill of TODO slots
 *   npm run wiki:check            lint only; exit 1 on errors
 *   npm run wiki:build -- --graph …also snapshot outputs/wiki-graph.json
 *
 *   Every run (except --check) also rebuilds the ENTITY graph — agents,
 *   models, tools, modules, tables, env vars and the typed relations
 *   between them — into wiki/.graph/graph.json, which is what the
 *   wiki_graph tool reads. Asserted (inferred) relations are never touched
 *   by the build: they live beside it in wiki/.graph/relations.json.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';

import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GPT_MODEL,
  DEFAULT_GROK_MODEL,
  DEFAULT_OLLAMA_MODEL,
  WIKI_AGENT_MODEL,
} from '../../lib/config.ts';
import { loadEnv } from '../../lib/loadEnv.ts';
import { renderCapabilityMatrix } from '../../lib/models/capabilities.ts';
import { PROVIDERS, providerForModel } from '../../lib/models/providerMap.ts';
import { SCIENCE_TOOL_CONTRACTS } from '../../lib/tools/scienceTools.ts';
import { TASK_TOOL_CONTRACTS } from '../../lib/tools/taskTools.ts';
import { toStandardJsonSchema, type ToolContract } from '../../lib/tools/toolContract.ts';
import { webExtractContract } from '../../lib/tools/webExtractTool.ts';
import { xApiSearchContract } from '../../lib/tools/xApiSearchTool.ts';
import { WIKI_TOOL_CONTRACTS } from '../../lib/tools/wikiTools.ts';
import {
  appendLog,
  indexSpec,
  upsertDoc,
  type DocSpec,
  type UpsertAction,
} from '../../lib/wiki/builder.ts';
import { repoDive } from '../../lib/wiki/dive.ts';
import {
  buildEntityGraph,
  docLayer,
  entityId,
  entityStats,
  lintEntityGraph,
  loadRelations,
  NODE_KINDS,
  relationEdges,
  RELATIONS,
  writeSnapshot,
  type EntityEdge,
  type EntityGraph,
  type EntityNode,
} from '../../lib/wiki/entities.ts';
import {
  scanModule,
  scanNpmScripts,
  scanObjectKeys,
  scanSql,
  tableMentions,
  walkFiles,
} from '../../lib/wiki/extract.ts';
import { fillVault } from '../../lib/wiki/fill.ts';
import { BUILD_ACTOR, OKF_VERSION } from '../../lib/wiki/format.ts';
import { buildGraph, graphStats, graphToJson, type WikiGraph } from '../../lib/wiki/graph.ts';
import { formatLintReport, lintVault } from '../../lib/wiki/lint.ts';
import { table } from '../../lib/wiki/markdown.ts';
import { loadVault, resolveWikiRoot, type Vault } from '../../lib/wiki/vault.ts';

loadEnv(import.meta.url);

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const wikiRoot = resolveWikiRoot();
const today = new Date().toISOString().slice(0, 10);
const ctx = { actor: BUILD_ACTOR, date: today };
const args = new Set(process.argv.slice(2));

// A deployment's private additions (build.private.ts), when present.
const PRIVATE_CONFIG = join(dirname(fileURLToPath(import.meta.url)), 'build.private.ts');
const priv: any = existsSync(PRIVATE_CONFIG) ? await import(pathToFileURL(PRIVATE_CONFIG).href) : {};

// The names that must never appear in public documents.
const FORBIDDEN_IN_PUBLIC: RegExp[] = priv.forbiddenInPublic ?? [];

/**
 * Syndicates whose knowledge lives under /private/, and the FAMILY directory
 * each belongs to (build.private.ts). A family per entry, not one private
 * directory: "private" and one topic must not be the same thing.
 */
const PRIVATE_SYNDICATES = new Map<string, string>(priv.privateSyndicates ?? []);

// ── Source: config/agents/*.yaml → syndicate docs ────────────────────────────

interface RawSubagent {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  mcp_server_url?: string;
  /** A subagent that IS another syndicate, resolved from its file at load time. */
  yaml_reference?: string;
}
interface RawSyndicate {
  syndicate_name?: string;
  memory_system?: string;
  max_steps?: number;
  orchestrator?: RawSubagent & { instruction?: string };
  subagents?: RawSubagent[];
  dispatch?: { default_route?: string };
}

/** Map YAML base name → npm script that runs it, from package.json. */
function syndicateRunScripts(): Map<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  const map = new Map<string, string>();
  for (const [name, cmd] of Object.entries(pkg.scripts)) {
    if (!cmd.includes('syndicate_chat.ts')) continue;
    const m = cmd.match(/--syndicate (\S+)/);
    const base = m ? m[1] : 'syndicate';
    if (!map.has(base) || name.startsWith('syndicate:')) map.set(base, name);
  }
  return map;
}

function firstSentence(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const dot = cleaned.indexOf('. ');
  return dot === -1 ? cleaned : cleaned.slice(0, dot + 1);
}

/** One parsed syndicate YAML, with the placements both layers agree on. */
interface LoadedSyndicate {
  base: string;
  file: string;
  cfg: RawSyndicate;
  isPrivate: boolean;
  bundlePath: string;
}

/** Read every syndicate YAML once — the doc specs and the entity layer share this. */
function loadSyndicates(): LoadedSyndicate[] {
  const dir = join(repoRoot, 'config', 'agents');
  const loaded: LoadedSyndicate[] = [];
  // Three places by design: the root holds this deployment's live
  // syndicates, examples/ the starter pack, templates/ the production
  // templates. `file` keeps the subdir-relative path so file entities and doc
  // sources name where the YAML actually lives.
  const sub = (name: string): string[] => {
    const d = join(dir, name);
    return existsSync(d)
      ? readdirSync(d)
          .filter((f) => f.endsWith('.yaml'))
          .map((f) => `${name}/${f}`)
      : [];
  };
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .concat(sub('examples'), sub('templates'));
  for (const file of files.sort()) {
    if (file === 'syndicateSchema.yaml') continue;
    const base = file.replace(/\.yaml$/, '').replace(/^(examples|templates)\//, '');
    const cfg = parseYaml(readFileSync(join(dir, file), 'utf-8')) as RawSyndicate;
    if (!cfg?.syndicate_name || !cfg.orchestrator) continue;
    // The root of config/agents is this deployment's own syndicates, private
    // since the deployment moved to its own repo (ADR 0022): a root file the
    // map does not name goes to /private/deployment/. A root file that shadows
    // a shipped example or template is the gitignored live copy (ADR 0011)
    // and is documented nowhere.
    const isRoot = !file.includes('/');
    if (isRoot && (files.includes(`examples/${file}`) || files.includes(`templates/${file}`))) continue;
    const family = PRIVATE_SYNDICATES.get(base) ?? (isRoot ? 'deployment' : undefined);
    loaded.push({
      base,
      file,
      cfg,
      isPrivate: family !== undefined,
      bundlePath: family ? `/private/${family}/${base}.md` : `/agents/${base}.md`,
    });
  }
  return loaded;
}

/** A `yaml_reference` subagent's Model cell: the nested syndicate, linked
 *  when it has a page. A private page is linked only from a private page
 *  in practice, because only private syndicates nest private ones. */
function nestedSyndicate(ref: string, pageOf: Map<string, string>): string {
  const id = ref.replace(/^(examples|templates)\//, '').replace(/\.yaml$/, '');
  const page = pageOf.get(id);
  return page ? `syndicate: [${id}](${page})` : `syndicate: \`${id}\``;
}

function syndicateSpecs(): DocSpec[] {
  const runScripts = syndicateRunScripts();
  const specs: DocSpec[] = [];
  const syndicates = loadSyndicates();
  const pageOf = new Map(syndicates.map((s) => [s.base, s.bundlePath]));

  for (const { base, file, cfg, isPrivate, bundlePath } of syndicates) {
    const orch = cfg.orchestrator!;
    const name = cfg.syndicate_name!;
    const subs = cfg.subagents ?? [];
    const fallbackDesc = name.startsWith('The ')
      ? `${name} syndicate.`
      : `The ${name} syndicate.`;

    const compositionLines: string[] = [];
    const run = runScripts.get(base);
    if (run) compositionLines.push(`Run: \`npm run ${run}\``, '');
    compositionLines.push(
      `- memory: \`${cfg.memory_system ?? 'session-only'}\`${
        cfg.max_steps ? ` · max_steps: ${cfg.max_steps}` : ''
      }`,
      `- orchestrator: **${orch.name ?? '?'}** (\`${orch.model ?? 'default'}\`)${
        orch.tools?.length ? ` · tools: ${orch.tools.map((t) => `\`${t}\``).join(', ')}` : ''
      }`,
      '',
      table(
        ['Subagent', 'Model', 'Tools', 'MCP'],
        subs.map((s) => [
          s.name ?? '?',
          s.yaml_reference ? nestedSyndicate(s.yaml_reference, pageOf) : `\`${s.model ?? 'default'}\``,
          (s.tools ?? []).map((t) => `\`${t}\``).join(', ') || '—',
          s.mcp_server_url ? '`mcp_server_url`' : '—',
        ]),
      ),
    );

    specs.push({
      bundlePath,
      fm: {
        type: 'syndicate',
        title: name,
        description: firstSentence(orch.description, fallbackDesc),
        tags: ['syndicate', ...(isPrivate ? ['private'] : [])],
        sources: [{ resource: `config/agents/${file}` }],
      },
      body: [
        { kind: 'prose', markdown: `# ${name}` },
        {
          kind: 'fill',
          id: 'charter',
          hint: 'why this syndicate exists, what it does well, and when to run it — from the YAML header comment and the orchestrator instruction',
        },
        {
          kind: 'generated',
          id: 'composition',
          source: `config/agents/${file}`,
          markdown: compositionLines.join('\n'),
        },
      ],
    });
  }
  return specs;
}

// ── Source: tool contracts → tool docs ───────────────────────────────────────

function contractsTable(contracts: readonly ToolContract<any>[]): string {
  return table(
    ['Tool', 'Arguments', 'Does'],
    contracts.map((c) => {
      const schema = toStandardJsonSchema(c) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      const required = new Set(schema.required ?? []);
      const argList = Object.keys(schema.properties ?? {})
        .map((k) => `\`${k}${required.has(k) ? '' : '?'}\``)
        .join(', ');
      return [`\`${c.name}\``, argList || '—', firstSentence(c.description, c.name)];
    }),
  );
}

function toolDocSpecs(): DocSpec[] {
  return [
    {
      bundlePath: '/tools/wiki-tools.md',
      fm: {
        type: 'tool',
        title: 'Wiki tools',
        description:
          'The knowledge-bundle tool surface: navigation, gated writing, and agentic composites, defined once as zod contracts.',
        tags: ['tools', 'wiki', 'mcp'],
        sources: [{ resource: 'lib/tools/wikiTools.ts' }],
      },
      body: [
        { kind: 'prose', markdown: '# Wiki tools' },
        {
          kind: 'fill',
          id: 'overview',
          hint: 'the three capability tiers (navigate / write / agentic) and why exposure stays deliberate',
        },
        {
          kind: 'generated',
          id: 'contracts',
          source: 'lib/tools/wikiTools.ts',
          markdown: contractsTable(WIKI_TOOL_CONTRACTS),
        },
        {
          kind: 'prose',
          markdown:
            'Serving: `npm run mcp:wiki` exposes all of these over SSE at `localhost:8933/sse` (`MCP_WIKI_PORT` changes the port). `wiki_query` and `wiki_garden` run a model in the server process, so they need a provider key in its environment. Syndicate agents declare the navigation tools, `wiki_save` and `wiki_relate` by name in YAML; the two composites are not registered for agents, because a syndicate reaches that behaviour by being the agent with the primitives. See [tool contracts](/tools/tool-contracts.md) for how one definition feeds both surfaces.',
        },
      ],
    },
    {
      bundlePath: '/tools/web-tools.md',
      fm: {
        type: 'tool',
        title: 'Web tools',
        description:
          'Reading the open web: deterministic page extraction as a contract, beside the provider-native search sentinels.',
        tags: ['tools', 'web'],
        sources: [
          { resource: 'lib/tools/webExtractTool.ts' },
          { resource: 'lib/tools/webSearchTool.ts' },
          { resource: 'lib/tools/xApiSearchTool.ts' },
        ],
      },
      body: [
        { kind: 'prose', markdown: '# Web tools' },
        {
          kind: 'fill',
          id: 'overview',
          hint: 'why search (server-side, provider-chosen snippets) and extract (client-side, agent-chosen URLs) are complements — search to find, extract to read past the headline',
        },
        {
          kind: 'generated',
          id: 'contracts',
          source: 'lib/tools/webExtractTool.ts',
          markdown: contractsTable([webExtractContract, xApiSearchContract]),
        },
        {
          kind: 'prose',
          markdown:
            '`web_search`, `x_search`, and `collections_search` are not contracts — they are sentinels that enable each provider\'s native server-side search (see [provider routing](/models/provider-routing.md)). `web_extract` and `x_api_search` execute client-side, so they work on any provider; `web_extract` alone needs no key and runs on local models.',
        },
      ],
    },
    ...(priv.privateToolSpecs?.(contractsTable) ?? []),
    // The science contracts get their OWN doc. They were briefly a second
    // `generated` part inside another family's spec, reusing `id:
    // 'contracts'` — and setGeneratedContent resolves a block by first match,
    // so the second write landed on the first block and every row of the
    // other family disappeared from the wiki. `assertUniquePartIds` below now makes that
    // class of mistake a build failure rather than silent data loss.
    {
      bundlePath: '/tools/evidence-tools.md',
      fm: {
        type: 'tool',
        title: 'Clinical-evidence tools',
        description:
          'Read-only clinical-evidence tool contracts: literature, preprints, the trial registry, citations and corrections.',
        tags: ['tools', 'science'],
        sources: [{ resource: 'lib/tools/scienceTools.ts' }],
      },
      body: [
        { kind: 'prose', markdown: '# Clinical-evidence tools' },
        {
          kind: 'generated',
          id: 'contracts',
          source: 'lib/tools/scienceTools.ts',
          markdown: contractsTable(SCIENCE_TOOL_CONTRACTS),
        },
        {
          kind: 'prose',
          markdown:
            'All seven are read-only fetches over free public APIs (Europe PMC, ClinicalTrials.gov v2, Crossref, OpenAlex); none mutates state. The channel decides the evidentiary ceiling in code, every result is a labelled text block carrying each record\'s identifier, ceiling and registry acronym, and the `science` guard (lib/guards/science.ts) verifies an answer against exactly that text. Served over MCP by `npm run mcp:science` at `localhost:8934/sse` (`MCP_SCIENCE_PORT` changes the port). `SCIENCE_API_CONTACT` sets the contact the sources\' polite pools ask for; without it, calls go out in the throttled pool.',
        },
      ],
    },
    {
      bundlePath: '/tools/task-tools.md',
      fm: {
        type: 'tool',
        title: 'Task tools',
        description:
          'A to-do list and a background-job queue in one local store; the tools write the queue, a separate worker runs it.',
        tags: ['tools', 'tasks'],
        sources: [
          { resource: 'lib/tools/taskTools.ts' },
          { resource: 'scripts/assistant_worker.ts' },
        ],
      },
      body: [
        { kind: 'prose', markdown: '# Task tools' },
        {
          kind: 'prose',
          markdown:
            'One store holds two kinds of record: `todo` (the user\'s own tasks: open → done | cancelled) and `background` (jobs: queued → running → done | failed). The store is a JSON file written atomically, at `MELCHIZEDEK_TASKS_FILE` or `outputs/tasks.json` under the working directory: deployment config, never YAML and never an argument. Every call re-reads it, so the conversation and the worker see each other\'s writes.',
        },
        {
          kind: 'generated',
          id: 'contracts',
          source: 'lib/tools/taskTools.ts',
          markdown: contractsTable(TASK_TOOL_CONTRACTS),
        },
        {
          kind: 'prose',
          markdown:
            '**The tools never run a job.** A tool that runs agents is the composite the [tool contract](/tools/tool-contracts.md) refuses, so `task_queue` only writes a record, and `scripts/assistant_worker.ts` (`npm run assistant:worker`; `melchizedek-worker` in the package) runs it: it claims the oldest queued job, runs its instruction as a fresh single turn through `runSyndicateTurn` (`lib/runtime/syndicateTurn.ts`) with one agent, and writes the result or the error back for `task_get`. The agent defaults to the [Assistant](/agents/assistant.md)\'s Worker; `--syndicate <file> --agent <name>` picks any syndicate and agent. A job left running by a dead worker is re-queued at the next start and failed after two interruptions; a job that runs past ten minutes is aborted and recorded as failed. Run one worker per store: the claim is a read-modify-write, not a lock.',
        },
        {
          kind: 'prose',
          markdown:
            'Exposure: the store is single-user. It is one file with no caller identity, so on a shared A2A endpoint every caller would share one list. A syndicate carrying these tools is for one person\'s machine. A job result is the worker\'s output and reaches the Assistant as material to report, never as instructions.',
        },
      ],
    },
  ];
}

/**
 * A `generated` or `fill` id must be unique WITHIN its doc.
 *
 * `setGeneratedContent` resolves a block by `doc.generated.find(b => b.id ===
 * blockId)` — first match, last write wins — so two parts sharing an id in one
 * spec silently overwrite each other. That is not hypothetical: one family's
 * contracts were briefly added to another family's doc under a second `id:
 * 'contracts'`, and every row of the first family vanished from the wiki with
 * no error on any build. Data loss that reproduces every run deserves to stop the
 * build, not to be found by reading the output.
 */
function assertUniquePartIds(specs: DocSpec[]): void {
  const problems: string[] = [];
  for (const spec of specs) {
    const seen = new Map<string, number>();
    for (const part of spec.body) {
      if (part.kind !== 'generated' && part.kind !== 'fill') continue;
      seen.set(part.id, (seen.get(part.id) ?? 0) + 1);
    }
    for (const [id, n] of seen) {
      if (n > 1) problems.push(`  ${spec.bundlePath}: ${n} parts share id "${id}"`);
    }
  }
  if (problems.length) {
    throw new Error(
      `duplicate generated/fill ids — each would overwrite the last:\n${problems.join('\n')}`,
    );
  }
}

// ── Source: db/*.sql → schema doc ────────────────────────────────────────────

function schemaSpec(): DocSpec {
  const sqlFence = (file: string): string =>
    `\`\`\`sql\n${readFileSync(join(repoRoot, 'db', file), 'utf-8').trim()}\n\`\`\``;
  // The install is db/migrations/ in numeric order, then hardening.sql
  // (scripts/db.ts); the page follows that order so it reads as the install.
  const migrations = readdirSync(join(repoRoot, 'db', 'migrations'))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  return {
    bundlePath: '/memory/schema.md',
    fm: {
      type: 'schema',
      title: 'Memory & telemetry schema',
      description:
        'The Postgres DDL shipped in db/, verbatim and in install order: the numbered migrations (sessions, memory facts, erase, the direct-Postgres tables, usage counters), the telemetry ledger, the row-level-security hardening and the memory_v2 upgrade.',
      tags: ['schema', 'postgres', 'supabase', 'memory'],
      sources: [
        ...migrations.map((f) => ({ resource: `db/migrations/${f}` })),
        { resource: 'db/telemetry.sql' },
        { resource: 'db/hardening.sql' },
        { resource: 'db/memory_v2.sql' },
      ],
    },
    body: [
      {
        kind: 'prose',
        markdown: `# Memory & telemetry schema

The generated sections below are the db/ files verbatim, in install order. \`npm run db -- apply\` runs the numbered migrations, then the hardening; with the ledger enabled, telemetry.sql and the hardening again. Every migration is idempotent and records itself in \`melchizedek_schema_version\`. The same SQL runs on Supabase or on any Postgres with pgvector ([ADR 0021](/decisions/0021-postgres-first-storage.md)).`,
      },
      ...migrations.map((f) => ({
        kind: 'generated' as const,
        id: `migration-${f.replace(/\.sql$/, '')}`,
        source: `db/migrations/${f}`,
        markdown: `## Migration ${f.replace(/\.sql$/, '')}\n\n${sqlFence(`migrations/${f}`)}`,
      })),
      {
        kind: 'generated',
        id: 'telemetry-ddl',
        source: 'db/telemetry.sql',
        markdown: `## Telemetry ledger (optional)\n\n${sqlFence('telemetry.sql')}`,
      },
      {
        kind: 'generated',
        id: 'hardening-ddl',
        source: 'db/hardening.sql',
        markdown: `## Hardening (RLS)\n\n${sqlFence('hardening.sql')}`,
      },
      {
        kind: 'generated',
        id: 'memory-ddl',
        source: 'db/memory_v2.sql',
        markdown: `## Upgrade path for databases created before the migrations\n\n${sqlFence('memory_v2.sql')}`,
      },
      {
        kind: 'prose',
        markdown:
          'How the pipeline uses these tables: [memory architecture](/memory/architecture.md).',
      },
    ],
  };
}

// ── Source: model registry → provider doc ────────────────────────────────────

function providerSpec(): DocSpec {
  const defaults: Record<string, string> = {
    gemini: DEFAULT_GEMINI_MODEL,
    anthropic: DEFAULT_CLAUDE_MODEL,
    openai: DEFAULT_GPT_MODEL,
    xai: DEFAULT_GROK_MODEL,
    ollama: DEFAULT_OLLAMA_MODEL,
  };
  const prefixes: Record<string, string> = {
    gemini: '`gemini-*`',
    anthropic: '`claude-*`',
    openai: '`gpt-*`, `o<digit>*`',
    xai: '`grok-*`',
    ollama: '`ollama/<model>`',
  };
  const rows = (Object.keys(PROVIDERS) as Array<keyof typeof PROVIDERS>).map((id) => [
    String(id),
    PROVIDERS[id].label,
    PROVIDERS[id].keyEnv ? `\`${PROVIDERS[id].keyEnv}\`` : '(keyless, local)',
    prefixes[String(id)] ?? '—',
    `\`${defaults[String(id)] ?? '—'}\``,
  ]);
  return {
    bundlePath: '/models/provider-routing.md',
    fm: {
      type: 'model-provider',
      title: 'Provider routing',
      description:
        'How a model string in YAML reaches the right provider adapter: one prefix table, five providers, availability by API key.',
      tags: ['models', 'routing'],
      sources: [
        { resource: 'lib/models/providerMap.ts' },
        { resource: 'lib/models/registry.ts' },
        { resource: 'lib/models/capabilities.ts' },
      ],
    },
    body: [
      { kind: 'prose', markdown: '# Provider routing' },
      {
        kind: 'fill',
        id: 'overview',
        hint: 'the two resolution paths (LLMRegistry string matching vs resolveModel instance factory) and why registration must happen before agent construction',
      },
      {
        kind: 'generated',
        id: 'providers',
        source: 'lib/models/providerMap.ts',
        markdown: table(['Provider', 'Label', 'Key env', 'Model prefix', 'Default'], rows),
      },
      {
        kind: 'prose',
        markdown:
          '## What each path can do\n\nAny provider may run any role, orchestrators included ([ADR 0019](/decisions/0019-multi-model-parity-matrix.md)). The matrix below is what each adapter sends, on the path a model id actually resolves to: a direct provider, or the gateway when that provider\'s key is absent. `npm run doctor -- --matrix` prints it, and the doctor flags any agent whose YAML needs a capability its path only partly gives (thinking with tools on Claude, an `outputSchema` on Ollama).',
      },
      {
        kind: 'generated',
        id: 'capabilities',
        source: 'lib/models/capabilities.ts',
        markdown: renderCapabilityMatrix(),
      },
      {
        kind: 'prose',
        markdown: `Wiki agent operations default to \`${WIKI_AGENT_MODEL}\` (WIKI_AGENT_MODEL in lib/config.ts). Schema-dialect bridging between Gemini-uppercase and standard JSON Schema is covered in [tool contracts](/tools/tool-contracts.md).`,
      },
    ],
  };
}

// ── Source: the entity vocabulary → the knowledge-graph document ─────────────

function graphSpec(stats: ReturnType<typeof entityStats>): DocSpec {
  const kindRows = Object.entries(NODE_KINDS)
    .sort((a, b) => (stats.byKind[b[0]] ?? 0) - (stats.byKind[a[0]] ?? 0))
    .map(([kind, gloss]) => [
      `\`${kind}\``,
      kind === 'doc' ? '`/dir/doc.md`' : `\`${kind}:<name>\``,
      String(stats.byKind[kind] ?? 0),
      gloss,
    ]);
  const relationRows = Object.entries(RELATIONS)
    .sort(
      (a, b) =>
        a[1].tier.localeCompare(b[1].tier) ||
        (stats.byRelation[b[0]] ?? 0) - (stats.byRelation[a[0]] ?? 0),
    )
    .map(([id, spec]) => [
      `\`${id}\``,
      spec.tier,
      `A ${spec.phrase} B`,
      String(stats.byRelation[id] ?? 0),
      spec.gloss,
    ]);

  return {
    bundlePath: '/meta/knowledge-graph.md',
    fm: {
      type: 'meta',
      title: 'The knowledge graph',
      description:
        'The second layer of this bundle: entities and typed relations derived from repo truth, plus the judgments asserted over them with evidence.',
      tags: ['meta', 'graph'],
      sources: [
        { resource: 'lib/wiki/entities.ts' },
        { resource: 'lib/wiki/extract.ts' },
        { resource: 'scripts/wiki/build.ts' },
      ],
    },
    body: [
      {
        kind: 'prose',
        markdown: `# The knowledge graph

Documents linked to documents answer *what should I read next*. They cannot answer *which syndicates call \`web_search\`*, *what stops working without \`XAI_API_KEY\`*, or *which decision constrains the memory schema* — because agents, tools, keys and tables are not documents. So the bundle carries a second layer over the same files: **entities**, joined by **typed relations**.

Two tiers, never mixed ([ADR 0005](/decisions/0005-entity-graph-layer.md)):

- **extracted** — a parser read it out of a YAML, a tool contract, DDL, an import statement, a markdown link. Rebuilt from scratch by \`npm run wiki:build\` on every run and thrown away; it cannot drift, because nothing preserves it.
- **inferred** — a person or an agent read prose and asserted it, with the sentence that justifies it and an actor id. The build never touches these; they live beside the snapshot and are read live.`,
      },
      {
        kind: 'generated',
        id: 'node-kinds',
        source: 'lib/wiki/entities.ts',
        markdown: `## What the graph knows about\n\n${table(
          ['Kind', 'Id form', 'Now', 'What it is'],
          kindRows,
        )}\n\nA document keeps its OKF identity — the bundle path — so the two namespaces cannot collide.`,
      },
      {
        kind: 'generated',
        id: 'relations',
        source: 'lib/wiki/entities.ts',
        markdown: `## The relation vocabulary\n\n${table(
          ['Relation', 'Tier', 'Reads as', 'Now', 'Meaning'],
          relationRows,
        )}`,
      },
      {
        kind: 'prose',
        markdown: `## Where it lives

Both stores sit in \`.graph/\` inside the bundle — a dot-directory, so the vault walker ignores them and no document operation can see them:

- \`.graph/graph.json\` — the derived snapshot: every node, every extracted relation, stamped with the build that produced it. Regenerate with \`npm run wiki:build\`; never edit it.
- \`.graph/relations.json\` — the asserted relations: \`from\`, \`to\`, \`rel\`, \`evidence\`, \`by\`, \`at\`. Written only through the gate.

A bundle is published as markdown only, so a derived map of PRIVATE structure never rides along: whoever receives it rebuilds the graph from what it actually holds ([ADR 0003](/decisions/0003-path-based-visibility.md)).

## Working it

[\`wiki_graph\`](/tools/wiki-tools.md) is the read path: no arguments for the census, \`find\` to locate a node, \`node\` to see everything attached to one, \`path_to\` for the chain joining two, \`kind\` to list a population. It reports its own staleness — documents added since the last build are named, not hidden.

\`wiki_relate\` is the only write path, and it refuses more than it accepts: an extracted relation (the build owns those), a missing endpoint, a public document pointing into the private annex, a duplicate, or an assertion without evidence. Accepted edges append to \`log.md\` under the \`relate\` op with the actor who made them.

The [Cartographers](/agents/cartographers.md) do this conversationally — the Surveyor reads and proposes with quotations, the Registrar records through the gate. [Gardening](/meta/gardening.md) covers the prose side of the same discipline, and [how this bundle works](/meta/wiki-system.md) the format underneath both.`,
      },
    ],
  };
}

// ── The entity layer: repo truth as a typed graph ────────────────────────────
//
// Everything below reads the SAME sources the documents derive from, but
// emits entities and typed relations instead of prose: syndicates and the
// agents inside them, the models those agents run on and the providers
// that serve them, tools, MCP endpoints, modules and their imports, tables,
// environment variables, npm entrypoints. The result answers the questions
// a document graph cannot ("which syndicates call web_search", "what dies
// without XAI_API_KEY") and is thrown away and rebuilt on every run —
// derived, never authored. Judgment goes in the OTHER store
// (wiki/.graph/relations.json), asserted with evidence and an actor.

/** Tool contract families, with the module that defines and doc that publishes each. */
const TOOL_FAMILIES: Array<{
  doc: string;
  module: string;
  contracts: readonly ToolContract<any>[];
  isPrivate: boolean;
}> = [
  {
    doc: '/tools/wiki-tools.md',
    module: 'lib/tools/wikiTools.ts',
    contracts: WIKI_TOOL_CONTRACTS,
    isPrivate: false,
  },
  {
    doc: '/tools/web-tools.md',
    module: 'lib/tools/webExtractTool.ts',
    contracts: [webExtractContract, xApiSearchContract],
    isPrivate: false,
  },
  {
    doc: '/tools/evidence-tools.md',
    module: 'lib/tools/scienceTools.ts',
    contracts: SCIENCE_TOOL_CONTRACTS,
    isPrivate: false,
  },
  {
    doc: '/tools/task-tools.md',
    module: 'lib/tools/taskTools.ts',
    contracts: TASK_TOOL_CONTRACTS,
    isPrivate: false,
  },
  ...(priv.privateToolFamilies ?? []),
];

/** Source files whose subject matter never leaves this repo. */
const PRIVATE_MODULES = new Set<string>(priv.privateModules ?? []);

const MODULE_ROOTS = ['lib', 'scripts'];

/**
 * Where an MCP server script declares the port it listens on, so a
 * declared `mcp_server_url` in a YAML lands on the SAME node as the script
 * that serves it. Only server modules are scanned — a file merely
 * DESCRIBING the pattern (this one, for instance) must not register as an
 * endpoint.
 */
const MCP_SERVER_MODULE_RE = /(?:_|\/)mcp_server\.ts$/;
const MCP_PORT_RE = /Number\(\s*process\.env\.MCP_[A-Z0-9_]+_PORT\s*\?\?\s*(\d+)/;

function privateName(text: string): boolean {
  return FORBIDDEN_IN_PUBLIC.some((re) => re.test(text));
}

/** Map a frontmatter `sources:` resource to a node id, minting the node if new. */
function resourceNode(resource: string): { id: string; node?: EntityNode; rel: string } {
  if (/^https?:\/\//.test(resource)) {
    const id = entityId('external', resource);
    return {
      id,
      node: { id, kind: 'external', label: resource.replace(/^https?:\/\//, ''), source: resource },
      rel: 'derives_from',
    };
  }
  const agentYaml = /^config\/agents\/([\w-]+)\.yaml$/.exec(resource);
  if (agentYaml) return { id: entityId('syndicate', agentYaml[1]), rel: 'documents' };
  if (/^(lib|scripts)\/.+\.ts$/.test(resource)) {
    return { id: entityId('module', resource), rel: 'derives_from' };
  }
  const id = entityId('file', resource);
  return {
    id,
    node: { id, kind: 'file', label: resource.split('/').pop() ?? resource, source: resource },
    rel: 'derives_from',
  };
}

function entityLayer(
  vault: Vault,
  docGraph: WikiGraph,
): { nodes: EntityNode[]; edges: EntityEdge[]; warnings: string[] } {
  const nodes: EntityNode[] = [];
  const edges: EntityEdge[] = [];
  const warnings: string[] = [];
  const add = (node: EntityNode): string => {
    nodes.push(node);
    return node.id;
  };
  const link = (from: string, rel: string, to: string, evidence: string): void => {
    edges.push({ from, to, rel, tier: 'extracted', evidence });
  };

  // Documents, restated as nodes — one graph, two layers.
  const docs = docLayer(docGraph);
  nodes.push(...docs.nodes);
  edges.push(...docs.edges);

  // ── Providers and the keys they need ──
  for (const [id, info] of Object.entries(PROVIDERS)) {
    const provider = add({
      id: entityId('provider', id),
      kind: 'provider',
      label: info.label,
      source: 'lib/models/providerMap.ts',
    });
    if (info.keyEnv) {
      add({
        id: entityId('env', info.keyEnv),
        kind: 'env',
        label: info.keyEnv,
        source: 'lib/models/providerMap.ts',
      });
      link(provider, 'requires_env', entityId('env', info.keyEnv), 'lib/models/providerMap.ts');
    }
  }

  /** Mint a model node the first time a model id is seen, and route it. */
  const seenModels = new Set<string>();
  const model = (id: string, source: string): string => {
    const nodeId = entityId('model', id);
    if (!seenModels.has(id)) {
      seenModels.add(id);
      add({ id: nodeId, kind: 'model', label: id, source });
      link(nodeId, 'routes_to', entityId('provider', providerForModel(id)), source);
    }
    return nodeId;
  };
  for (const [name, id] of Object.entries({
    DEFAULT_GEMINI_MODEL,
    DEFAULT_CLAUDE_MODEL,
    DEFAULT_GPT_MODEL,
    DEFAULT_GROK_MODEL,
    DEFAULT_OLLAMA_MODEL,
    WIKI_AGENT_MODEL,
  })) {
    model(id, `lib/config.ts (${name})`);
  }

  // ── Tool contracts, and the registry names a YAML may declare ──
  const knownTools = new Set<string>();
  for (const family of TOOL_FAMILIES) {
    for (const contract of family.contracts) {
      knownTools.add(contract.name);
      const tool = add({
        id: entityId('tool', contract.name),
        kind: 'tool',
        label: contract.name,
        source: family.module,
        ...(family.isPrivate ? { private: true } : {}),
        attrs: { description: firstSentence(contract.description, contract.name) },
      });
      link(tool, 'defined_in', entityId('module', family.module), family.module);
      link(family.doc, 'documents', tool, family.doc);
    }
  }
  const registryText = readFileSync(join(repoRoot, 'lib', 'toolRegistry.ts'), 'utf-8');
  for (const name of scanObjectKeys(registryText, 'BUILTIN_TOOLS')) {
    knownTools.add(name);
    add({
      id: entityId('tool', name),
      kind: 'tool',
      label: name,
      source: 'lib/toolRegistry.ts',
      ...(privateName(name) ? { private: true } : {}),
    });
  }

  // ── Syndicates: agents, their models, tools, and MCP endpoints ──
  for (const { base, file, cfg, isPrivate, bundlePath } of loadSyndicates()) {
    const yamlPath = `config/agents/${file}`;
    add({
      id: entityId('file', yamlPath),
      kind: 'file',
      label: file,
      source: yamlPath,
      ...(isPrivate ? { private: true } : {}),
    });
    const syndicate = add({
      id: entityId('syndicate', base),
      kind: 'syndicate',
      label: cfg.syndicate_name ?? base,
      source: yamlPath,
      ...(isPrivate ? { private: true } : {}),
      attrs: {
        memory: cfg.memory_system ?? 'session-only',
        agents: 1 + (cfg.subagents?.length ?? 0),
        mode: cfg.dispatch ? 'plan-dispatch' : 'delegate',
        ...(cfg.dispatch?.default_route ? { default_route: cfg.dispatch.default_route } : {}),
      },
    });
    link(syndicate, 'defined_in', entityId('file', yamlPath), yamlPath);
    link(bundlePath, 'documents', syndicate, bundlePath);

    const members: Array<{ role: string; raw: RawSubagent }> = [
      { role: 'orchestrator', raw: cfg.orchestrator as RawSubagent },
      ...(cfg.subagents ?? []).map((raw) => ({ role: 'subagent', raw })),
    ];
    for (const { role, raw } of members) {
      if (!raw?.name) continue;
      const agent = add({
        id: entityId('agent', `${base}/${raw.name}`),
        kind: 'agent',
        label: raw.name,
        source: yamlPath,
        ...(isPrivate ? { private: true } : {}),
        attrs: {
          role,
          syndicate: base,
          ...(raw.description ? { description: firstSentence(raw.description, raw.name) } : {}),
        },
      });
      link(syndicate, 'contains', agent, yamlPath);

      if (raw.yaml_reference) {
        const ref = raw.yaml_reference.replace(/\.yaml$/, '');
        link(agent, 'delegates_to', entityId('syndicate', ref), `${yamlPath} (yaml_reference)`);
      }
      const modelId = raw.model ?? cfg.orchestrator?.model;
      if (modelId) link(agent, 'uses_model', model(modelId, yamlPath), yamlPath);

      for (const toolName of raw.tools ?? []) {
        if (!knownTools.has(toolName)) {
          warnings.push(`${yamlPath}: ${raw.name} declares unknown tool "${toolName}"`);
          add({
            id: entityId('tool', toolName),
            kind: 'tool',
            label: toolName,
            source: yamlPath,
            attrs: { unresolved: true },
          });
        }
        link(agent, 'uses_tool', entityId('tool', toolName), yamlPath);
      }
      if (raw.mcp_server_url) {
        add({
          id: entityId('mcp-server', raw.mcp_server_url),
          kind: 'mcp-server',
          label: raw.mcp_server_url,
          source: yamlPath,
          ...(isPrivate ? { private: true } : {}),
        });
        link(agent, 'connects_mcp', entityId('mcp-server', raw.mcp_server_url), yamlPath);
      }
    }
  }

  // ── Database: what the DDL defines, and who names it ──
  const tables = new Set<string>();
  for (const rel of walkFiles(repoRoot, join(repoRoot, 'db'), { extensions: ['.sql'] })) {
    const text = readFileSync(join(repoRoot, rel), 'utf-8');
    add({ id: entityId('file', rel), kind: 'file', label: rel.split('/').pop()!, source: rel });
    const scan = scanSql(text);
    for (const name of scan.defined) {
      tables.add(name);
      add({ id: entityId('table', name), kind: 'table', label: name, source: rel });
      link(entityId('table', name), 'defined_in', entityId('file', rel), rel);
    }
    for (const name of scan.referenced) {
      tables.add(name);
      add({
        id: entityId('table', name),
        kind: 'table',
        label: name,
        source: rel,
        attrs: { created_upstream: true },
      });
    }
  }

  // ── Modules: imports, environment reads, table access, served MCP ports ──
  const moduleFiles = MODULE_ROOTS.flatMap((root) =>
    walkFiles(repoRoot, join(repoRoot, root), {
      extensions: ['.ts'],
      skipDirs: ['export-public'],
    }),
  );
  const moduleText = new Map<string, string>();
  for (const rel of moduleFiles) {
    const text = readFileSync(join(repoRoot, rel), 'utf-8');
    moduleText.set(rel, text);
    add({
      id: entityId('module', rel),
      kind: 'module',
      label: rel,
      source: rel,
      ...(PRIVATE_MODULES.has(rel) ? { private: true } : {}),
      attrs: { lines: text.split('\n').length },
    });
  }
  const tableList = [...tables];
  for (const [rel, text] of moduleText) {
    const moduleId = entityId('module', rel);
    const scan = scanModule(text, rel);
    for (const target of scan.localImports) {
      if (moduleText.has(target)) link(moduleId, 'imports', entityId('module', target), rel);
    }
    for (const name of scan.envVars) {
      add({
        id: entityId('env', name),
        kind: 'env',
        label: name,
        source: rel,
        ...(privateName(name) ? { private: true } : {}),
      });
      link(moduleId, 'requires_env', entityId('env', name), rel);
    }
    for (const name of tableMentions(text, tableList)) {
      link(moduleId, 'reads_table', entityId('table', name), rel);
    }
    const port = MCP_SERVER_MODULE_RE.test(rel) ? MCP_PORT_RE.exec(text) : null;
    if (port) {
      const url = `http://localhost:${port[1]}/sse`;
      add({
        id: entityId('mcp-server', url),
        kind: 'mcp-server',
        label: url,
        source: rel,
        ...(PRIVATE_MODULES.has(rel) ? { private: true } : {}),
      });
      link(entityId('mcp-server', url), 'defined_in', moduleId, rel);
    }
  }

  // ── npm entrypoints ──
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
    scripts: Record<string, string>;
  };
  for (const script of scanNpmScripts(pkg.scripts)) {
    if (!script.entry && !script.flags.syndicate) continue;
    const id = add({
      id: entityId('script', script.name),
      kind: 'script',
      label: `npm run ${script.name}`,
      source: 'package.json',
      attrs: { command: script.command },
    });
    if (script.entry && moduleText.has(script.entry)) {
      link(id, 'runs', entityId('module', script.entry), 'package.json');
    }
    if (script.flags.syndicate) {
      link(id, 'runs', entityId('syndicate', script.flags.syndicate), 'package.json');
    }
  }

  // ── What each document declares it derives from ──
  for (const doc of vault.docs.values()) {
    if (doc.kind !== 'concept') continue;
    for (const source of doc.fm?.sources ?? []) {
      const resolved = resourceNode(source.resource);
      if (resolved.node) add(resolved.node);
      link(doc.bundlePath, resolved.rel, resolved.id, `${doc.bundlePath} frontmatter`);
    }
  }

  return { nodes, edges, warnings };
}

// ── Indexes ──────────────────────────────────────────────────────────────────

const DIR_DESCRIPTIONS: Record<string, string> = {
  overview: 'what melchizedek is and how its parts fit together',
  agents: 'the syndicates — one document per agent team',
  tools: 'the tool layer: contracts, registries, exposure doctrine',
  models: 'provider routing and model optionality',
  memory: 'long-term memory: pipeline, schema, supersession',
  protocols: 'interop surfaces: MCP and A2A',
  operations: 'setup, failure modes, deployment, agent skills',
  decisions: 'architecture decision records, newest first',
  meta: 'how this knowledge bundle itself works',
  private: 'the private annex — knowledge that never leaves this repo',
};

function refreshIndexes(): void {
  const vault = loadVault(wikiRoot);
  const dirs = new Map<string, boolean>(); // dir → isPrivate
  for (const doc of vault.docs.values()) {
    const parts = doc.bundlePath.split('/').filter(Boolean);
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = `/${parts.slice(0, depth).join('/')}/`;
      dirs.set(dir, dir.startsWith('/private/') || dir === '/private/');
    }
  }

  for (const [dir] of dirs) {
    const entries = [...vault.docs.values()]
      .filter(
        (d) =>
          d.kind === 'concept' &&
          d.bundlePath.startsWith(dir) &&
          !d.bundlePath.slice(dir.length).includes('/'),
      )
      .map((d) => ({
        bundlePath: d.bundlePath,
        title: d.title,
        description: String(d.fm?.description ?? d.fm?.type ?? 'concept'),
      }))
      .sort((a, b) => a.bundlePath.localeCompare(b.bundlePath));
    const subdirs = [...dirs.keys()]
      .filter((d) => d !== dir && d.startsWith(dir) && !d.slice(dir.length, -1).includes('/'))
      .sort()
      .map((d) => ({
        bundlePath: d,
        title: d.slice(dir.length, -1),
        description: DIR_DESCRIPTIONS[d.split('/').filter(Boolean).pop() ?? ''] ?? 'section',
      }));
    const name = dir.split('/').filter(Boolean).pop() ?? '';
    const title = name.charAt(0).toUpperCase() + name.slice(1);
    upsertDoc(wikiRoot, indexSpec(dir, title, entries, subdirs), ctx);
  }

  // Root index: top-level directories only; the private annex is deliberately
  // NOT listed — the public bundle exports without it, and locally wiki_map
  // still shows it (see /decisions/0003-path-based-visibility.md).
  const topDirs = [...dirs.keys()]
    .filter((d) => d.split('/').filter(Boolean).length === 1 && d !== '/private/')
    .sort()
    .map((d) => ({
      bundlePath: d,
      title: d.slice(1, -1),
      description: DIR_DESCRIPTIONS[d.slice(1, -1)] ?? 'section',
    }));
  upsertDoc(
    wikiRoot,
    indexSpec('/', 'Melchizedek knowledge bundle', [], topDirs, {
      okf_version: OKF_VERSION,
      title: 'Melchizedek knowledge bundle',
      description:
        'The framework\'s company brain: agents, tools, models, memory, protocols, operations, decisions — as one linked OKF bundle.',
    }),
    ctx,
  );
}

/**
 * Derive the entity graph, merge the asserted relations, and (unless this
 * is a lint-only run) refresh the snapshot the wiki tools read. The
 * snapshot lives inside the bundle at `.graph/graph.json`: it travels with
 * WIKI_ROOT, the vault walker ignores dot-directories, and the export
 * pipeline copies markdown only — so a derived graph of PRIVATE structure
 * can never ride along to the public repo by accident.
 */
function entityPass(
  vault: Vault,
  docGraph: WikiGraph,
  options: { write: boolean },
): {
  graph: EntityGraph;
  findings: ReturnType<typeof lintEntityGraph>;
  warnings: string[];
  inferred: number;
} {
  const layer = entityLayer(vault, docGraph);
  const relations = loadRelations(wikiRoot);
  const graph = buildEntityGraph(layer.nodes, [
    ...layer.edges,
    ...relationEdges(relations.records),
  ]);
  if (options.write) writeSnapshot(wikiRoot, graph, { by: BUILD_ACTOR, at: today });
  return {
    graph,
    findings: lintEntityGraph(graph),
    warnings: [...layer.warnings, ...relations.issues],
    inferred: relations.records.length,
  };
}

function reportEntityPass(pass: ReturnType<typeof entityPass>): void {
  const stats = entityStats(pass.graph);
  const kinds = Object.entries(stats.byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind}(${n})`)
    .join(', ');
  console.log(
    `entities: ${stats.nodes} nodes, ${stats.edges} edges (${stats.byTier.extracted} extracted, ${stats.byTier.inferred} inferred), ${stats.isolated} isolated`,
  );
  console.log(`  kinds: ${kinds}`);
  for (const warning of pass.warnings) console.log(`  warning: ${warning}`);
  const errors = pass.findings.filter((f) => f.severity === 'error');
  const others = pass.findings.filter((f) => f.severity !== 'error');
  for (const finding of [...errors, ...others].slice(0, 12)) {
    console.log(`  graph-${finding.severity}: ${finding.rule} — ${finding.message}`);
  }
  if (pass.findings.length > 12) {
    console.log(`  …and ${pass.findings.length - 12} more graph finding(s)`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // This script builds MELCHIZEDEK's bundle specifically: its specs name
  // this repo's documents, and its entity layer joins them to this repo's
  // agents and modules. Pointed at someone else's bundle it would emit
  // edges into documents that do not exist there. The generic gate for any
  // other OKF bundle is scripts/wiki/check.ts (`WIKI_ROOT=… wiki:check` in
  // the public repo); refuse here rather than produce a confusing report.
  const ownBundle = resolve(repoRoot, 'wiki');
  if (wikiRoot !== ownBundle) {
    console.error(
      `scripts/wiki/build.ts builds this repo's bundle (${ownBundle}), but WIKI_ROOT is ${wikiRoot}.\n` +
        'For any other OKF bundle use the generic gate: ' +
        'WIKI_ROOT=<path> node --experimental-strip-types scripts/wiki/check.ts',
    );
    process.exit(2);
  }
  if (!existsSync(wikiRoot)) mkdirSync(wikiRoot, { recursive: true });

  if (args.has('--check')) {
    const vault = loadVault(wikiRoot);
    const report = lintVault(vault, { forbiddenPatterns: FORBIDDEN_IN_PUBLIC });
    console.log(formatLintReport(report));
    // The graph is linted too, without being rewritten: a dangling
    // assertion or a public document pointing into the private annex is a
    // publishing defect, and this is the gate a publish runs.
    const pass = entityPass(vault, buildGraph(vault), { write: false });
    reportEntityPass(pass);
    const graphErrors = pass.findings.filter((f) => f.severity === 'error').length;
    process.exit(report.ok && graphErrors === 0 ? 0 : 1);
  }

  const tally: Record<UpsertAction, number> = { created: 0, updated: 0, unchanged: 0 };
  // The graph document states the CURRENT census, so derive the entity layer
  // once before writing docs (no snapshot written yet), then again at the end
  // over the finished bundle — that second pass is the one tools read.
  const preVault = loadVault(wikiRoot);
  const preStats = entityStats(
    entityPass(preVault, buildGraph(preVault), { write: false }).graph,
  );
  const specs: DocSpec[] = [
    ...syndicateSpecs(),
    ...toolDocSpecs(),
    schemaSpec(),
    providerSpec(),
    graphSpec(preStats),
  ];
  assertUniquePartIds(specs);
  for (const spec of specs) {
    tally[upsertDoc(wikiRoot, spec, ctx)]++;
  }
  refreshIndexes();
  console.log(
    `structural build: ${tally.created} created, ${tally.updated} updated, ${tally.unchanged} unchanged`,
  );

  if (args.has('--fill')) {
    const vault = loadVault(wikiRoot);
    const outcome = await fillVault(vault, {
      model: process.env.WIKI_AGENT_MODEL ?? WIKI_AGENT_MODEL,
      date: today,
      log: (m) => console.log(`  ${m}`),
    });
    console.log(
      outcome.skippedReason ??
        `fill: ${outcome.slotsFilled} slot(s) filled across ${outcome.docsTouched} doc(s), ${outcome.slotsFailed} failed`,
    );
    if (outcome.docsTouched > 0) refreshIndexes();
  }

  const vault = loadVault(wikiRoot);
  const graph = buildGraph(vault);
  const stats = graphStats(graph);

  // The entity layer is rebuilt on EVERY run, not just --graph: it is the
  // read path for wiki_graph, so a stale snapshot would be worse than none.
  const pass = entityPass(vault, graph, { write: true });

  if (args.has('--graph')) {
    const outDir = join(repoRoot, 'outputs');
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, 'wiki-graph.json');
    writeFileSync(file, JSON.stringify(graphToJson(graph), null, 2));
    console.log(`document-graph snapshot: ${file}`);
  }

  const report = lintVault(vault, { forbiddenPatterns: FORBIDDEN_IN_PUBLIC });
  console.log(formatLintReport(report));
  console.log(
    `bundle: ${stats.documents} docs, ${stats.concepts} concepts, ${stats.edges} links, ${stats.totalWords} words, ${stats.orphans} orphan(s)`,
  );
  reportEntityPass(pass);

  // Only a build that creates documents is logged: regenerated tables change
  // on every source edit, and git already records those.
  if (tally.created > 0) {
    appendLog(
      wikiRoot,
      today,
      'build',
      `structural build: ${tally.created} created, ${tally.updated} updated`,
      `by ${BUILD_ACTOR}`,
    );
  }

  // Smoke-test the dive so a broken scorer is caught at build time.
  const dive = repoDive(vault, 'add a new provider adapter', 4000, graph);
  if (dive.stops.length === 0) {
    console.warn('warning: repo-dive returned an empty plan for a known-good task');
  }
}

await main();
