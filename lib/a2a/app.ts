/**
 * lib/a2a/app.ts — the A2A server as a library: `createA2AApp(options)`
 * returns an Express app (mount it, or listen on it) plus a `shutdown()`
 * that drains in-flight tasks. `scripts/a2a_server.ts` (the
 * `melchizedek-serve` bin) is a thin wrapper that reads the environment,
 * listens, and handles signals.
 *
 * Middleware order, and why:
 *   1. /healthz, /readyz — unauthenticated, so a load balancer or
 *      Kubernetes probe needs no secret. They reveal nothing but liveness.
 *   2. Failed-auth limiter — counts only 401s per IP, so the shared secret
 *      cannot be guessed online at whatever rate the host allows.
 *   3. Bearer check (when a secret is configured), constant-time.
 *   4. JSON body parser (configurable limit).
 *   5. BYOK headers → per-request AsyncLocalStorage context. Agent-card GETs
 *      are exempt from X-API-Key: discovery must not require a model key.
 *   6. Task rate limiter (POSTs only; polling GETs are exempt).
 *   7. Routes: DELETE /memory, POST /v1/x-packet, the default syndicate at
 *      /a2a/*, and every other syndicate at /:agentId/a2a/*.
 *
 * State that is per-process (documented, not hidden): the A2A task store,
 * the handler cache, the rate-limiter counters. Sessions and memory are
 * durable when Supabase is configured. Run one replica, or put sticky
 * routing in front, until the task store is durable.
 */

import express from 'express';
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { AGENT_CARD_PATH } from '@a2a-js/sdk';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3';
import type { TaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, restHandler } from '@a2a-js/sdk/server/express';
import { InMemorySessionService } from '@google/adk';
import type { BaseLlm, BaseMemoryService, BaseSessionService } from '@google/adk';

import { loadSyndicate, loadSyndicateFromRegistry } from '../loadSyndicate.ts';
import type { SyndicateYamlConfig } from '../loadSyndicate.ts';
import { providerForModel, resolveModel } from '../models/registry.ts';
import type { ProviderId } from '../models/registry.ts';
import { createSupabaseServices, hasSupabaseCredentials } from '../persistence/supabaseProvider.ts';
import { buildXPacket, normalizeTickers } from '../tools/xPacket.ts';
import { eraseScope } from '../memory/erase.ts';
import type { EraseCounts } from '../memory/erase.ts';
import { namespacedMemoryService } from '../memory/namespace.ts';
import type { Embedder, MemoryExtractor } from '../memory/providers.ts';
import {
  A2A_APP_NAME,
  SyndicateExecutor,
  TaskLimiter,
  deriveUserId,
  requestContextStorage,
} from './executor.ts';
import type { A2AContext, SurfaceContext } from './executor.ts';
import { HEADER_VALUE_PATTERN, SCOPE_KEY_PATTERN } from './identity.ts';
import type { IdentityScheme } from './identity.ts';
const SURFACE_HEADERS = [
  ['x-surface', 'name'],
  ['x-surface-guild', 'guild'],
  ['x-surface-channel', 'channel'],
  ['x-surface-user', 'user'],
] as const;

/** Agent ids address a config (file or "registry:<id>"): a safe charset only. */
export function isValidAgentId(agentId: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(agentId) && !agentId.includes('..');
}

export interface A2AAppOptions {
  /** The syndicate served at /a2a/*: a YAML name or "registry:<id>". */
  defaultSyndicate: string;
  /** Externally reachable base URL, used in agent cards. Default: http://localhost:<port>. */
  publicUrl?: string;
  /** Port the caller will listen on; used only for the default card URL. */
  port?: number;
  /** Bearer secret every request must present. Undefined = no bearer check. */
  serverSecret?: string;
  /**
   * Storage plug point (ADR 0017/0021). Default: Supabase when credentials
   * exist, else in-memory. `taskStore` builds the A2A task store for one
   * agent id (default: in-process).
   */
  storage?: {
    sessionService: BaseSessionService;
    memoryService?: BaseMemoryService;
    taskStore?: (agentId: string) => TaskStore;
    /** Erase everything stored for a scope (DELETE /memory). Without it the route answers 501. */
    erase?: (scopeKey: string, options: { namespace?: string; includeNested?: boolean }) => Promise<EraseCounts>;
  };
  /**
   * Who pays for models, and how a caller's data is scoped (ADR 0017).
   *  - 'server' (default): models run on the server's credentials (env, or
   *    the `credentials` plug point); X-API-Key is not used; data is scoped by
   *    X-User-Id, else 'default'.
   *  - 'byok': the caller's X-API-Key funds its X-Provider (required on every
   *    task request), and its hash prefixes the scope so key holders stay
   *    isolated from one another. This is the pre-0.16 behaviour: a
   *    deployment with data stored under key-hash silos keeps reaching it
   *    only in this mode.
   */
  keyMode?: 'server' | 'byok';
  /**
   * Identity plug point (ADR 0017): authenticate the request your way (a JWT,
   * a gateway header, mTLS) and return the opaque scope key data is stored
   * under. Return undefined (or throw) to refuse with 401. Runs after the
   * bearer check, when one is configured. Replaces `keyMode`'s scoping but
   * not its billing: under 'byok' the caller's X-API-Key still pays unless
   * the identity supplies a key. Built-in authenticators: lib/a2a/identity.ts.
   */
  resolveRequest?: (req: Request) => RequestIdentity | undefined | Promise<RequestIdentity | undefined>;
  /** What the agent card declares for `resolveRequest` (the built-in
   *  authenticators supply it). A 'header' scheme requires `serverSecret`. */
  identityScheme?: IdentityScheme;
  /**
   * Credentials plug point (ADR 0017/0023): the API key for a provider, for
   * this request — from a secret manager, per tenant, anywhere. Undefined
   * falls back to the server environment. Ignored when `resolveModel` is set.
   */
  credentials?: (provider: ProviderId, ctx: A2AContext) => string | undefined;
  /** Bare agent ids that resolve from the registry (ADR 0018). Others are files only. */
  registryAgents?: string[];
  /**
   * Memory plug point (ADR 0020): the fact extractor and embedder the
   * default Supabase memory service uses. Ignored when `storage` supplies a
   * memoryService. Default: from MEMORY_* environment variables (Gemini).
   */
  memory?: { extractor?: MemoryExtractor; embedder?: Embedder };
  /** Adopter routes, mounted after authentication and before the A2A routes. */
  routes?: (app: Express) => void;
  /** Refuse to start when Supabase hardening is missing (public deployments). */
  requireHardenedDb?: boolean;
  /** Wall-clock budget per task, ms. 0 = none. */
  taskTimeoutMs?: number;
  /** Concurrent tasks across all agents. 0 = unlimited. */
  maxConcurrentTasks?: number;
  /** Task submissions (POST) per window per client IP. */
  rateLimit?: { windowMs: number; max: number };
  /** Failed authentications per window per client IP before the IP is blocked. */
  authFailureLimit?: { windowMs: number; max: number };
  /** Express `trust proxy` setting (hop count, boolean, or subnet list). */
  trustProxy?: number | boolean | string;
  /** JSON body size limit, e.g. "1mb". */
  bodyLimit?: string;
  /**
   * Allowlist of agent ids reachable at /:agentId/*. Undefined = any id with
   * a file in the deployment's own agents directory. Ids listed here may also
   * resolve to the shipped examples/ and templates/; unlisted ids never do,
   * so a missing file cannot be answered by a public example (ADR 0018).
   */
  servedAgents?: string[];
  /**
   * Model resolution per request. Default: lib/models/registry.ts with the
   * caller's X-API-Key scoped to its X-Provider. Override to route through
   * your own gateway or credential store.
   */
  resolveModel?: (modelName: string | undefined, ctx: A2AContext) => string | BaseLlm | undefined;
  /** Bindings applied at every config load (e.g. current_date). */
  bindings?: () => Record<string, string>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/** What the identity plug point returns for an authenticated request. */
export interface RequestIdentity {
  /** Opaque key the caller's sessions and memory are stored under: [A-Za-z0-9._/-], ≤ 160. */
  scopeKey: string;
  /** A provider key for this request (BYOK-style). */
  apiKey?: string;
  /** The provider `apiKey` belongs to. */
  provider?: string;
  /** Which caller this is, for logs (a caller name, 'jwt', …). */
  caller?: string;
  /** The scope owns `<scopeKey>/…` beneath it (a caller's end users), so an
   *  erasure with no end user removes those too. */
  ownsNested?: boolean;
}

const legacyCompat = { enabled: true };

/**
 * The A2A user for a request: the caller's scope key, as resolved by the
 * identity middleware. The task store keys tasks by this owner, so one
 * caller cannot read, follow or cancel another's task by its id.
 */
const scopeUserBuilder = async () => {
  const ctx = requestContextStorage.getStore();
  const userName = ctx?.scopeKey ?? '';
  return { get isAuthenticated() { return !!userName; }, get userName() { return userName; } };
};

export interface A2AApp {
  app: Express;
  /** The default syndicate's resolved config. */
  config: SyndicateYamlConfig;
  /** Session backend in use: durable, or process memory. */
  sessionBackend: 'durable' | 'in-memory';
  /** Stop admitting tasks, wait up to `graceMs` for running ones, cancel the rest.
   *  Resolves with the number of tasks that had to be canceled. */
  shutdown(graceMs: number): Promise<number>;
}

interface Handlers {
  /** Serves this agent's card, with URLs for the base the request reached. */
  card: RequestHandler;
  jsonRpc: RequestHandler;
  rest: RequestHandler;
}

/**
 * Build the agent card for one syndicate at one route prefix, in the A2A 1.0
 * shape. Each transport is advertised twice — once for 1.0 clients and once
 * (protocolVersion 0.3) for the 0.3 clients most platforms still run — and
 * the card handler serves a 0.3-shaped card to a request that asks for 0.3
 * (or sends no A2A-Version header, which the spec says means 0.3).
 */
export function compileAgentCard(
  config: SyndicateYamlConfig,
  opts: {
    baseUrl: string;
    routePrefix?: string;
    /** The server secret is checked (A2A_SERVER_SECRET). */
    bearer: boolean;
    /** The plugged-in authenticator's scheme, when there is one. */
    identity?: IdentityScheme;
    version: string;
    byok?: boolean;
  },
): AgentCard {
  const base = `${opts.baseUrl.replace(/\/$/, '')}${opts.routePrefix ?? ''}`;
  const securitySchemes: AgentCard['securitySchemes'] = {};
  if (opts.byok) {
    securitySchemes.apiKey = {
      scheme: {
        $case: 'apiKeySecurityScheme',
        value: {
          description: "The caller's model-provider key (BYOK). Required on every task request.",
          location: 'header',
          name: 'X-API-Key',
        },
      },
    };
  }
  if (opts.identity?.type === 'bearer') {
    // The authenticator reads the bearer itself (caller tokens, a JWT).
    securitySchemes.bearer = {
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: { description: opts.identity.description, scheme: 'bearer', bearerFormat: opts.identity.bearerFormat ?? '' },
      },
    };
  } else if (opts.bearer) {
    securitySchemes.bearer = {
      scheme: {
        $case: 'httpAuthSecurityScheme',
        value: { description: 'The server secret (A2A_SERVER_SECRET).', scheme: 'bearer', bearerFormat: '' },
      },
    };
  }
  if (opts.identity?.type === 'header') {
    securitySchemes.identity = {
      scheme: {
        $case: 'apiKeySecurityScheme',
        value: { description: opts.identity.description, location: 'header', name: opts.identity.name },
      },
    };
  }
  const requirement: Record<string, { list: string[] }> = {};
  for (const name of Object.keys(securitySchemes)) requirement[name] = { list: [] };
  return {
    name: config.orchestrator.name,
    description: config.orchestrator.description || 'Syndicate Orchestrator Agent',
    supportedInterfaces: duplicateInterfacesForLegacy(
      [
        { url: `${base}/a2a/jsonrpc`, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
        { url: `${base}/a2a/rest`, protocolBinding: 'HTTP+JSON', tenant: '', protocolVersion: '1.0' },
      ],
      ['JSONRPC', 'HTTP+JSON'],
    ),
    provider: undefined,
    version: opts.version,
    capabilities: {
      // SendStreamingMessage is served: progress arrives as `[STATUS]`
      // working updates and the answer as the final status message.
      streaming: true,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes,
    securityRequirements: Object.keys(requirement).length ? [{ schemes: requirement }] : [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain'],
    skills: (config.subagents ?? []).map((sub) => ({
      id: sub.name,
      name: sub.name,
      description: sub.description || 'Subagent collaborator',
      tags: sub.tools || [],
      examples: [],
      inputModes: [],
      outputModes: [],
      securityRequirements: [],
    })),
    signatures: [],
  };
}

/**
 * The app name a syndicate's sessions and memory are stored under: its
 * declared `memory_namespace` (ADR 0020), else the server-wide name every
 * syndicate shared before namespaces existed — kept so data stored then
 * stays reachable.
 */
export function memoryAppName(cfg: SyndicateYamlConfig): string {
  return cfg.memory_namespace || A2A_APP_NAME;
}

export async function createA2AApp(options: A2AAppOptions): Promise<A2AApp> {
  const log = options.log ?? ((m: string) => console.log(`[A2A] ${m}`));
  const warn = options.warn ?? ((m: string) => console.warn(`[A2A] ⚠ ${m}`));
  const bindings = options.bindings ?? (() => ({
    current_date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
  }));
  const baseUrl = options.publicUrl || `http://localhost:${options.port ?? 4000}`;
  const keyMode = options.keyMode ?? 'server';
  // Billing and scoping are separate (ADR 0025): 'byok' always means the
  // caller's X-API-Key pays; it decides the scope only when no
  // authenticator is plugged in (the pre-0.16 key-hash silo).
  const byokBilling = keyMode === 'byok';
  const byokScoping = byokBilling && !options.resolveRequest;
  if (options.identityScheme?.type === 'header' && !options.serverSecret) {
    throw new Error('A trusted-header authenticator needs serverSecret: without it any client could set the header.');
  }

  // ── The default syndicate ──────────────────────────────────────────────────
  const config = options.defaultSyndicate.startsWith('registry:')
    ? await loadSyndicateFromRegistry(options.defaultSyndicate.slice('registry:'.length), { bindings: bindings() })
    : loadSyndicate(options.defaultSyndicate, { bindings: bindings() });

  // ── Persistence ────────────────────────────────────────────────────────────
  let durableSessions: BaseSessionService | undefined;
  let memoryService: BaseMemoryService | undefined;
  let erase: NonNullable<A2AAppOptions['storage']>['erase'];
  if (options.storage) {
    durableSessions = options.storage.sessionService;
    memoryService = options.storage.memoryService;
    erase = options.storage.erase;
  } else if (hasSupabaseCredentials()) {
    // Embeddings and fact extraction use the SERVER's Gemini key: memory is
    // operator infrastructure, like tools.
    const services = await createSupabaseServices({
      apiKey: process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY || '',
      withMemory: true,
      extractor: options.memory?.extractor,
      embedder: options.memory?.embedder,
    });
    durableSessions = services.sessionService;
    memoryService = services.memoryService;
    erase = (scopeKey, eraseOpts) => eraseScope(services.rpcClient, scopeKey, eraseOpts);
    const rls = await services.checkRlsHardening();
    if (rls.applied) {
      log(`✓ DB hardening verified — ${rls.detail}.`);
    } else if (options.requireHardenedDb) {
      throw new Error(
        `Supabase hardening is missing (${rls.detail}). User transcripts and memory facts are exposed `
        + 'to the anon API key. Run db/hardening.sql, or set ALLOW_UNHARDENED_DB=true to accept the risk.',
      );
    } else {
      warn(`Supabase hardening not applied — ${rls.detail}. Run db/hardening.sql before serving real user data.`);
    }
  }
  const sessionBackend: A2AApp['sessionBackend'] = durableSessions ? 'durable' : 'in-memory';

  /**
   * Session and memory services for one syndicate, honouring its
   * `memory_system`: `internal-only` keeps transcripts in process memory
   * even when Supabase is configured (the docs promise "nothing persists"),
   * and only `long-term` syndicates get the memory service.
   */
  const internalSessions = new InMemorySessionService();
  const servicesFor = (cfg: SyndicateYamlConfig) => {
    const mode = cfg.memory_system;
    const sessionService = mode === 'internal-only' || !durableSessions ? internalSessions : durableSessions;
    // Pinned to the syndicate's namespace (ADR 0020), so every agent the
    // turn reaches — including AgentTool children, which run under their own
    // ADK app name — recalls and stores in the root syndicate's memory.
    const memory = mode === 'long-term' && memoryService ? namespacedMemoryService(memoryService, memoryAppName(cfg)) : undefined;
    if (mode === 'long-term' && !memoryService) {
      warn(`'${cfg.syndicate_name}' requests long-term memory but Supabase is not configured — memory disabled.`);
    }
    if ((mode === 'session-only' || mode === 'long-term') && !durableSessions) {
      warn(`'${cfg.syndicate_name}' requests ${mode} sessions but Supabase is not configured — sessions live in process memory and are lost on restart.`);
    }
    return { sessionService, memoryService: memory, durable: sessionService !== internalSessions };
  };

  const limiter = new TaskLimiter(options.maxConcurrentTasks ?? 0);
  // The YAML model id always wins (its prefix names the provider). What
  // differs is whose credential pays: an adopter's resolver, the
  // credentials plug point, the caller's key (byok), or the server's env.
  const modelResolverFor = (ctx: A2AContext) => (modelName?: string) => {
    if (options.resolveModel) return options.resolveModel(modelName, ctx);
    if (options.credentials) {
      const provider = providerForModel(modelName ?? '');
      const apiKey = options.credentials(provider, ctx);
      return apiKey ? resolveModel(modelName, { apiKey, defaultProvider: provider }) : resolveModel(modelName);
    }
    if (ctx.apiKey) return resolveModel(modelName, { apiKey: ctx.apiKey, defaultProvider: ctx.provider });
    return resolveModel(modelName);
  };
  const compileFor = (ctx: A2AContext) => ({
    resolveModel: modelResolverFor(ctx),
    onUnknownTool: (name: string) => warn(`Unknown tool '${name}' — skipping.`),
    log,
  });

  const buildHandlers = (cfg: SyndicateYamlConfig, routePrefix: string, agentId: string): Handlers => {
    const services = servicesFor(cfg);
    const executor = new SyndicateExecutor({
      config: cfg,
      sessionService: services.sessionService,
      memoryService: services.memoryService,
      compileFor,
      taskTimeoutMs: options.taskTimeoutMs,
      limiter,
      log,
      warn,
    });
    const version = executor.configHashFor().slice(0, 12);
    const cardFor = (base: string) =>
      compileAgentCard(cfg, {
        baseUrl: base,
        routePrefix,
        bearer: !!options.serverSecret,
        identity: options.resolveRequest ? options.identityScheme : undefined,
        version,
        byok: byokBilling,
      });
    const card = cardFor(baseUrl);
    const taskStore = options.storage?.taskStore?.(agentId) ?? new InMemoryTaskStore();
    const handler = new DefaultRequestHandler(card, taskStore, executor);
    return {
      // With PUBLIC_URL the card names that base. Without it, the base is
      // the one this request reached — a server on port 4097 must not
      // advertise :4000, and a client that follows the card must land here.
      card: options.publicUrl
        ? (agentCardHandler({ agentCardProvider: handler, legacyCompat }) as RequestHandler)
        : (req: Request, res: Response, next: NextFunction) => {
            const base = `${req.protocol}://${req.get('host') ?? `localhost:${options.port ?? 4000}`}`;
            const perRequest = agentCardHandler({ agentCardProvider: async () => cardFor(base), legacyCompat }) as RequestHandler;
            perRequest(req, res, next);
          },
      // legacyCompat: A2A 0.3 requests (method names, part shapes, enum
      // spellings) are translated to and from 1.0, so 0.3 clients keep working.
      jsonRpc: jsonRpcHandler({ requestHandler: handler, userBuilder: scopeUserBuilder, legacyCompat }) as RequestHandler,
      rest: restHandler({ requestHandler: handler, userBuilder: scopeUserBuilder, legacyCompat }) as RequestHandler,
    };
  };

  const app = express();
  app.set('trust proxy', options.trustProxy ?? 1);
  app.disable('x-powered-by');

  // ── 1. Health ──────────────────────────────────────────────────────────────
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', (_req, res) => {
    if (limiter.isDraining) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    res.json({ status: 'ready', sessions: sessionBackend, inFlight: limiter.inFlight });
  });

  // ── 2–3. Authentication ───────────────────────────────────────────────────
  const failWindow = options.authFailureLimit ?? { windowMs: 15 * 60 * 1000, max: 30 };
  app.use(
    rateLimit({
      windowMs: failWindow.windowMs,
      max: failWindow.max,
      standardHeaders: true,
      legacyHeaders: false,
      // Only failed authentications count; a valid caller never spends this.
      skipSuccessfulRequests: true,
      requestWasSuccessful: (_req: Request, res: Response) => res.statusCode !== 401,
      message: { error: 'Too many failed authentication attempts; try again later.' },
    }),
  );
  const rejectAuth = (req: Request, res: Response, error: string) => {
    warn(`401 ${req.method} ${req.path} from ${req.ip}: ${error}`);
    res.status(401).json({ error });
  };
  if (options.serverSecret) {
    const expected = Buffer.from(options.serverSecret);
    app.use((req, res, next) => {
      const header = req.headers.authorization;
      if (!header || !header.startsWith('Bearer ')) {
        rejectAuth(req, res, 'Unauthorized: Missing or invalid Authorization Bearer token');
        return;
      }
      const token = Buffer.from(header.substring(7));
      if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
        rejectAuth(req, res, 'Unauthorized: Invalid Authorization Bearer token');
        return;
      }
      next();
    });
  }

  // ── 4. Body ────────────────────────────────────────────────────────────────
  app.use(express.json({ limit: options.bodyLimit ?? '1mb' }));

  // ── 5. Caller context: who is calling, and whose data this is ──────────
  // Agent-card GETs need no caller context: discovery must not require a
  // model key or an identity.
  const isCardRequest = (req: Request) =>
    req.method === 'GET' && (req.path.endsWith('/agent-card.json') || req.path.endsWith('/agent.json'));
  let warnedIgnoredKey = false;
  app.use(async (req, res, next) => {
    if (isCardRequest(req)) {
      // A card is behind the same credential as the agent, never public:
      // with no server-secret gate, the authenticator itself must accept
      // the request (a model key is still not needed to read a card).
      if (options.resolveRequest && !options.serverSecret) {
        let identity: RequestIdentity | undefined;
        try {
          identity = await options.resolveRequest(req);
        } catch (err: unknown) {
          warn(`resolveRequest refused ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!identity) {
          rejectAuth(req, res, 'Unauthorized');
          return;
        }
      }
      next();
      return;
    }
    // X-Surface-*: telemetry only. A bad value is refused, not dropped — a
    // silently ignored header makes a dashboard lie about coverage.
    let surface: SurfaceContext | undefined;
    for (const [header, field] of SURFACE_HEADERS) {
      const raw = req.headers[header] as string | undefined;
      if (raw === undefined || raw === '') continue;
      if (!HEADER_VALUE_PATTERN.test(raw)) {
        res.status(400).json({ error: `Invalid ${header}: must match [A-Za-z0-9._-]{1,64}` });
        return;
      }
      if (field === 'name') {
        surface = { name: raw };
        continue;
      }
      if (!surface) {
        res.status(400).json({ error: `${header} requires X-Surface to name the surface` });
        return;
      }
      surface[field] = raw;
    }

    // The adopter's identity system decides, when one is plugged in.
    if (options.resolveRequest) {
      let identity: RequestIdentity | undefined;
      try {
        identity = await options.resolveRequest(req);
      } catch (err: unknown) {
        warn(`resolveRequest refused ${req.method} ${req.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!identity) {
        rejectAuth(req, res, 'Unauthorized');
        return;
      }
      if (!SCOPE_KEY_PATTERN.test(identity.scopeKey)) {
        warn(`resolveRequest returned an invalid scopeKey for ${req.path}`);
        res.status(500).json({ error: 'Server identity configuration error.' });
        return;
      }
      // Billing follows keyMode, whoever the caller is: under 'byok' the
      // caller's own X-API-Key funds its X-Provider unless the identity
      // supplied a key (a per-tenant key from a secret manager, say).
      let apiKey = identity.apiKey ?? '';
      let provider = identity.provider ?? ((req.headers['x-provider'] as string | undefined) || 'google');
      if (!apiKey && byokBilling) {
        apiKey = (req.headers['x-api-key'] as string | undefined) ?? '';
        if (!apiKey) {
          rejectAuth(req, res, 'Unauthorized: Missing X-API-Key header');
          return;
        }
      }
      if (identity.apiKey && !identity.provider) provider = 'google';
      requestContextStorage.run(
        {
          apiKey,
          provider,
          scopeKey: identity.scopeKey,
          surface,
          caller: identity.caller,
          ownsNested: identity.ownsNested ?? false,
        },
        () => next(),
      );
      return;
    }

    // X-User-Id: the caller's own end-user id. The calling backend (which
    // passed the bearer check) authenticates its users before sending it.
    const rawUserId = req.headers['x-user-id'] as string | undefined;
    let siteUserId: string | undefined;
    if (rawUserId !== undefined && rawUserId !== '') {
      if (!HEADER_VALUE_PATTERN.test(rawUserId)) {
        res.status(400).json({ error: 'Invalid X-User-Id: must match [A-Za-z0-9._-]{1,64}' });
        return;
      }
      siteUserId = rawUserId;
    }
    const apiKey = req.headers['x-api-key'] as string | undefined;
    const provider = (req.headers['x-provider'] as string | undefined) || 'google';

    if (byokScoping) {
      if (!apiKey) {
        rejectAuth(req, res, 'Unauthorized: Missing X-API-Key header');
        return;
      }
      // The caller's key funds its provider, and its hash prefixes the scope
      // so no key holder can reach another's data.
      const scopeKey = deriveUserId({ apiKey, siteUserId });
      requestContextStorage.run(
        { apiKey, provider, siteUserId, scopeKey, surface, caller: 'shared-secret', ownsNested: !siteUserId },
        () => next(),
      );
      return;
    }

    // Server mode: the server's credentials pay; X-API-Key is not used.
    if (apiKey && !warnedIgnoredKey) {
      warnedIgnoredKey = true;
      warn('A caller sent X-API-Key, which server key mode ignores. Set A2A_KEY_MODE=byok (keyMode: \'byok\') if callers fund their own inference — and to keep reaching sessions and memory stored under key-hash silos.');
    }
    requestContextStorage.run(
      { apiKey: '', provider, siteUserId, scopeKey: siteUserId ?? 'default', surface },
      () => next(),
    );
  });

  // ── 6. Task rate limit ────────────────────────────────────────────────────
  // Runaway/cost protection for authenticated callers. GETs (task polling)
  // are exempt; the limit targets task submissions.
  const rl = options.rateLimit ?? { windowMs: 15 * 60 * 1000, max: 60 };
  app.use(
    rateLimit({
      windowMs: rl.windowMs,
      max: rl.max,
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.method === 'GET',
      message: { error: 'Too many requests, please try again later.' },
    }),
  );

  // ── 7. Routes ──────────────────────────────────────────────────────────────
  // The adopter's own routes first: they see the authenticated caller
  // context (requestContextStorage) like the built-in ones.
  options.routes?.(app);

  // Right-to-erasure (ADR 0020): everything stored for the CALLING scope —
  // facts, sessions (with their subagent rows), ledger turns, spans and
  // payloads — in one operation, with per-store counts. Scoped to the
  // default syndicate's memory namespace; `?all=1` covers every namespace.
  // A caller whose scope owns nested end-user scopes (a caller token, or a
  // BYOK key silo) and sends no X-User-Id erases its scope and every one
  // beneath it. The scope comes from the authenticated context, so a caller
  // can erase only what it could write.
  app.delete('/memory', async (req, res) => {
    if (!erase) {
      res.status(501).json({ error: 'Erasure needs durable storage; this server has none configured.' });
      return;
    }
    const ctx = requestContextStorage.getStore();
    if (!ctx) {
      res.status(401).json({ error: 'No authentication context.' });
      return;
    }
    const all = req.query.all === '1' || req.query.all === 'true';
    try {
      const counts = await erase(ctx.scopeKey, {
        namespace: all ? undefined : memoryAppName(config),
        includeNested: !!ctx.ownsNested,
      });
      log(`Erasure for scope ${ctx.scopeKey}${all ? ' (all namespaces)' : ''}: ${JSON.stringify(counts)}`);
      res.json({ deleted: counts });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`Erasure failed: ${msg}`);
      res.status(503).json({ error: msg });
    }
  });

  // POST /v1/x-packet — a deterministic cashtag chatter packet for an
  // operator pipeline. It spends the operator's X_BEARER_TOKEN, so it is
  // served only behind the bearer secret.
  app.post('/v1/x-packet', async (req, res) => {
    if (!options.serverSecret) {
      res.status(403).json({ error: 'x-packet requires A2A_SERVER_SECRET on this server.' });
      return;
    }
    const { ok, refused } = normalizeTickers(req.body?.tickers);
    if (ok.length === 0) {
      res.status(400).json({ error: 'Body must be {"tickers": ["SYM", ...]} with cashtag-shaped symbols.', refused });
      return;
    }
    try {
      res.json({ ...(await buildXPacket(ok)), ...(refused.length ? { refused } : {}) });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warn(`x-packet failed: ${msg}`);
      res.status(503).json({ error: msg });
    }
  });

  // The default syndicate at the root routes.
  const root = buildHandlers(config, '', 'default');
  app.use(`/${AGENT_CARD_PATH}`, root.card);
  app.use('/a2a/jsonrpc', root.jsonRpc);
  app.use('/a2a/rest', root.rest);

  // Every other syndicate at /:agentId/... — loaded on first request, then
  // cached for the process lifetime (a config change needs a restart).
  // The in-flight load is cached, not just the result, so a burst of first
  // requests builds ONE handler (and one task store) instead of several.
  const handlerCache = new Map<string, Promise<Handlers>>();
  const unknownAgents = new Map<string, number>(); // id → time of the failed load
  const UNKNOWN_TTL_MS = 30_000;

  // ADR 0018: a bare id is a FILE in the deployment's own agents directory.
  // The registry answers only `registry:<id>`, or a bare id the operator
  // listed in `registryAgents` — never as an implicit preference, and with
  // no silent fallback between the two. The shipped examples/ and templates/
  // answer only ids listed in `servedAgents`.
  const registryIds = new Set(options.registryAgents ?? []);
  const served = options.servedAgents ? new Set(options.servedAgents) : undefined;
  class AgentNotFound extends Error {}

  const loadAgentConfig = async (agentId: string): Promise<{ config: SyndicateYamlConfig; source: string }> => {
    const registryId = agentId.startsWith('registry:') ? agentId.slice('registry:'.length) : registryIds.has(agentId) ? agentId : undefined;
    if (registryId) {
      try {
        return { config: await loadSyndicateFromRegistry(registryId, { bindings: bindings() }), source: `registry:${registryId}` };
      } catch (err: unknown) {
        const why = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(why)) throw new AgentNotFound(`registry has no row '${registryId}'`);
        throw err; // validation failure or registry outage: 503, never a file substitute
      }
    }
    const file = agentId.endsWith('.yaml') ? agentId : `${agentId}.yaml`;
    try {
      return {
        config: loadSyndicate(file, { bindings: bindings(), shippedFallback: !!served?.has(agentId) }),
        source: `file:${file}`,
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') throw new AgentNotFound(`no file ${file}`);
      throw err;
    }
  };

  const handlersFor = (agentId: string): Promise<Handlers> => {
    const cached = handlerCache.get(agentId);
    if (cached) return cached;
    const pending = (async () => {
      const { config: cfg, source } = await loadAgentConfig(agentId);
      log(`⚙ Loaded '${agentId}' from ${source}`);
      return buildHandlers(cfg, `/${agentId}`, agentId);
    })();
    handlerCache.set(agentId, pending);
    pending.catch(() => handlerCache.delete(agentId));
    return pending;
  };

  const dynamic = (pick: (h: Handlers) => RequestHandler, label: string) =>
    async (req: Request, res: Response, next: NextFunction) => {
      const agentId = String(req.params.agentId);
      if (req.method !== 'GET') log(`${req.method} /${agentId}/${label}`);
      const failedAt = unknownAgents.get(agentId);
      if (!isValidAgentId(agentId) || (served && !served.has(agentId)) || (failedAt && Date.now() - failedAt < UNKNOWN_TTL_MS)) {
        res.status(404).json({ error: `Unknown agent '${agentId.slice(0, 80)}'.` });
        return;
      }
      try {
        pick(await handlersFor(agentId))(req, res, next);
      } catch (err: unknown) {
        // The detail (which can carry server paths) stays in the log.
        const detail = err instanceof Error ? err.message : String(err);
        if (err instanceof AgentNotFound) {
          warn(`Unknown agent '${agentId}': ${detail}`);
          unknownAgents.set(agentId, Date.now());
          res.status(404).json({ error: `Unknown agent '${agentId.slice(0, 80)}'.` });
        } else {
          // An invalid config or a registry outage: the agent exists but
          // cannot be served right now. Not cached — the next request retries.
          warn(`Agent '${agentId}' could not be loaded: ${detail}`);
          res.setHeader('Retry-After', '30');
          res.status(503).json({ error: `Agent '${agentId.slice(0, 80)}' is unavailable; see the server log.` });
        }
      }
    };

  app.use('/:agentId/.well-known/agent-card.json', dynamic((h) => h.card, 'agent-card'));
  app.use('/:agentId/agent-card.json', dynamic((h) => h.card, 'agent-card'));
  app.use('/:agentId/a2a/jsonrpc', dynamic((h) => h.jsonRpc, 'a2a/jsonrpc'));
  app.use('/:agentId/a2a/rest', dynamic((h) => h.rest, 'a2a/rest'));

  return {
    app,
    config,
    sessionBackend,
    shutdown: (graceMs: number) => limiter.drain(graceMs),
  };
}
