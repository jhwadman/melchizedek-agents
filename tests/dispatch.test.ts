/**
 * Plan-dispatch routing invariants — fully offline, no API keys, no network.
 *
 * `resolveRoute` is the seam between a model's free-form output and code that
 * must run SOMETHING. Every path through it has to end on a real subagent,
 * because the alternative is a user who asked a question and got nothing.
 * That is not a hypothetical failure: the relay turn this method replaces
 * shipped two blank/garbled replies to Discord in as many days.
 *
 * So the tests below are mostly about garbage in — malformed JSON, unknown
 * names, empty strings, a misconfigured default — and the single assertion
 * that matters in all of them is that a declared subagent comes out.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { isDispatchSyndicate, matchRouteOverride, resolveRoute } from '../lib/dispatch.ts';
import { loadSyndicate } from '../lib/loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../lib/loadSyndicate.ts';
import type { DispatchConfig } from '../lib/dispatch.ts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Every shipped example and template that declares a dispatch block. */
const SHIPPED_DISPATCH = ['examples', 'templates'].flatMap((dir) =>
  readdirSync(join(process.cwd(), 'config', 'agents', dir))
    .filter((f) => f.endsWith('.yaml') && /^dispatch:/m.test(readFileSync(join(process.cwd(), 'config', 'agents', dir, f), 'utf-8')))
    .map((f) => f),
);

const CONFIG = {
  syndicate_name: 'Test Router',
  dispatch: { default_route: 'DeskAnalyst' },
  orchestrator: { name: 'Triage', model: 'x', instruction: 'y' },
  subagents: [
    { name: 'Conversationalist', description: 'small talk' },
    { name: 'TopicalGeneralist', description: 'lookups' },
    { name: 'DeskAnalyst', description: 'analysis' },
    { name: 'XScout', description: 'x recon' },
  ],
} as unknown as SyndicateYamlConfig & { dispatch: DispatchConfig };

test('isDispatchSyndicate keys off a usable dispatch block', () => {
  assert.equal(isDispatchSyndicate(CONFIG), true);
  assert.equal(isDispatchSyndicate({ ...CONFIG, dispatch: undefined } as any), false);
  // A block without a default_route cannot fail static, so it does not count.
  assert.equal(isDispatchSyndicate({ ...CONFIG, dispatch: {} } as any), false);
});

test('a well-formed verdict routes and carries its reason', () => {
  const r = resolveRoute('{"route":"XScout","reason":"wants live X sentiment"}', CONFIG);
  assert.equal(r.route, 'XScout');
  assert.equal(r.reason, 'wants live X sentiment');
  assert.equal(r.fellBack, false);
});

test('a missing reason is tolerated — only the route is required', () => {
  const r = resolveRoute('{"route":"Conversationalist"}', CONFIG);
  assert.equal(r.route, 'Conversationalist');
  assert.equal(r.reason, '');
  assert.equal(r.fellBack, false);
});

test('a fenced JSON block still routes', () => {
  // responseMimeType normally prevents fences; tolerated so a provider that
  // ignores the hint degrades to the right route, not the default.
  const r = resolveRoute('```json\n{"route":"TopicalGeneralist"}\n```', CONFIG);
  assert.equal(r.route, 'TopicalGeneralist');
  assert.equal(r.fellBack, false);
});

test('route matching ignores case and punctuation drift', () => {
  for (const variant of ['desk analyst', 'desk_analyst', 'DESKANALYST', ' XScout ']) {
    const r = resolveRoute(JSON.stringify({ route: variant }), CONFIG);
    assert.equal(r.fellBack, false, `"${variant}" should match a declared subagent`);
  }
  assert.equal(resolveRoute('{"route":"x-scout"}', CONFIG).route, 'XScout');
});

test('every malformed verdict falls back to the default route', () => {
  const garbage = [
    '',
    '   ',
    'DeskAnalyst',              // the bare-name failure, now in the router seat
    'I think this should go to XScout.',
    '{"route":}',
    '["XScout"]',                    // array, not object
    'null',
    '{"reason":"no route key"}',
    '{"route":""}',
    '{"route":42}',
    '{"route":"Nonexistent"}',
  ];
  for (const raw of garbage) {
    const r = resolveRoute(raw, CONFIG);
    assert.equal(r.route, 'DeskAnalyst', `"${raw}" must fall back`);
    assert.equal(r.fellBack, true);
    assert.ok(r.fallbackReason.length > 0, 'a fallback must say why, for the logs');
  }
});

test('a default_route naming nothing still yields a runnable subagent', () => {
  // Operator error in YAML. Answering with the wrong specialist beats not
  // answering, so the first declared subagent is used and the log says so.
  const broken = { ...CONFIG, dispatch: { default_route: 'DoesNotExist' } } as typeof CONFIG;
  const r = resolveRoute('not json', broken);
  assert.equal(r.route, 'Conversationalist');
  assert.equal(r.fellBack, true);
  assert.match(r.fallbackReason, /is not a declared subagent/);
});

test('custom route_key / reason_key are honoured', () => {
  const custom = {
    ...CONFIG,
    dispatch: { default_route: 'DeskAnalyst', route_key: 'agent', reason_key: 'why' },
  } as typeof CONFIG;
  const r = resolveRoute('{"agent":"XScout","why":"social recon"}', custom);
  assert.equal(r.route, 'XScout');
  assert.equal(r.reason, 'social recon');
  // The default keys must no longer be read once overridden.
  assert.equal(resolveRoute('{"route":"XScout"}', custom).fellBack, true);
});

// ── Deterministic overrides ───────────────────────────────────────────────
// These decide a route from what the message CONTAINS, before any model runs.
// The bar is high on both sides: a rule that fails to fire re-creates the
// 2026-08-15 misroute (an x.com link answered by an agent that cannot open
// X), and a rule that over-fires is worse still — the classifier cannot
// reason around it.

const OVERRIDE_CONFIG = {
  ...CONFIG,
  dispatch: {
    default_route: 'DeskAnalyst',
    route_overrides: [
      { route: 'XScout', pattern: 'x\\.com/', reason: 'reading the linked X post' },
    ],
  },
} as typeof CONFIG;

test('an override pins its route without the classifier, carrying its reason', () => {
  const r = matchRouteOverride('analyze https://x.com/kalshi/status/1 for me', OVERRIDE_CONFIG);
  assert.equal(r?.route, 'XScout');
  assert.equal(r?.reason, 'reading the linked X post');
  assert.equal(r?.viaOverride, true);
  assert.equal(r?.fellBack, false);
});

test('no match, no overrides, and no text all leave classification alone', () => {
  assert.equal(matchRouteOverride('what is your read on SPOT?', OVERRIDE_CONFIG), null);
  assert.equal(matchRouteOverride('', OVERRIDE_CONFIG), null);
  assert.equal(matchRouteOverride('https://x.com/a/1', CONFIG), null);
});

test('a broken override rule is skipped, never fatal — the classifier still answers', () => {
  const broken = {
    ...CONFIG,
    dispatch: {
      default_route: 'DeskAnalyst',
      route_overrides: [
        { route: 'NotADeclaredAgent', pattern: 'x\\.com/' },   // unknown route
        { route: 'XScout', pattern: '([unclosed' },            // invalid regex
        { route: 'Conversationalist', pattern: 'hello there' }, // valid, later
      ],
    },
  } as typeof CONFIG;
  const warnings: string[] = [];
  assert.equal(matchRouteOverride('https://x.com/a/1', broken, warnings), null);
  assert.equal(warnings.length, 2);
  // A later valid rule still works — one bad entry does not poison the list.
  assert.equal(matchRouteOverride('well hello there', broken)?.route, 'Conversationalist');
});

test('the first matching override wins, and route names are matched loosely', () => {
  const many = {
    ...CONFIG,
    dispatch: {
      default_route: 'DeskAnalyst',
      route_overrides: [
        { route: 'x-scout', pattern: 'x\\.com/' },       // punctuation drift tolerated
        { route: 'Conversationalist', pattern: 'x\\.com/' },
      ],
    },
  } as typeof CONFIG;
  assert.equal(matchRouteOverride('see https://x.com/a/1', many)?.route, 'XScout');
});

test('resolveRoute never reports itself as an override', () => {
  assert.equal(resolveRoute('{"route":"XScout"}', CONFIG).viaOverride, false);
  assert.equal(resolveRoute('garbage', CONFIG).viaOverride, false);
});

test('the route property is an enum matching the declared subagents exactly', () => {
  // A described string lets the classifier invent a name that resolveRoute
  // then has to repair; an enum makes it impossible at the API boundary. The
  // enum and the subagent list are two spellings of one fact, so drift
  // between them (a route added to one, renamed in the other) fails here.
  for (const file of SHIPPED_DISPATCH) {
    const config = loadSyndicate(file);
    const route = (config.orchestrator as any).outputSchema?.properties?.route;
    assert.ok(Array.isArray(route?.enum), `${file}: route must declare an enum`);
    assert.deepEqual(
      [...route.enum].sort(),
      (config.subagents ?? []).map(s => s.name).sort(),
      `${file}: the route enum and the declared subagents must name the same set`,
    );
  }
});

test('every shipped dispatch syndicate is valid', () => {
  for (const file of SHIPPED_DISPATCH) {
  const config = loadSyndicate(file);
  assert.ok(isDispatchSyndicate(config), 'router must declare a dispatch block');

  const names = (config.subagents ?? []).map(s => s.name);
  assert.ok(
    names.includes(config.dispatch!.default_route),
    `default_route '${config.dispatch!.default_route}' must be one of ${names.join(', ')}`,
  );

  // The classifier must be a leaf holding a schema: ADK refuses to combine
  // outputSchema with AgentTool delegation, and code — not the model — owns
  // the hand-off in this method.
  const orchestrator = config.orchestrator as any;
  assert.ok(orchestrator.outputSchema, 'Triage must declare an outputSchema');
  assert.equal(String(orchestrator.outputSchema.properties?.route?.type).toUpperCase(), 'STRING', `${file}: route is a string`);
  assert.ok(orchestrator.outputSchema.required?.includes('route'), `${file}: route is required`);
  assert.equal(orchestrator.generateContentConfig?.responseMimeType, 'application/json');
  assert.ok(!orchestrator.tools, 'a dispatch classifier holds no tools');

  // Every route the classifier may name must exist, or dispatch throws.
  for (const name of names) {
    assert.match(orchestrator.instruction, new RegExp(name),
      `${name} must appear in the routing rules`);
  }
  }
});
