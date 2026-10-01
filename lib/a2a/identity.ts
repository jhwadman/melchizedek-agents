/**
 * lib/a2a/identity.ts — built-in authenticators for the identity plug point
 * (ADR 0017, ADR 0025).
 *
 * Each factory returns an `Authenticator`: a `resolveRequest` for
 * createA2AApp plus the scheme its agent card should declare, so
 * `createA2AApp({ ...callerTokens(callers) })` is the whole wiring.
 *
 *  - callerTokens     one bearer token per calling backend. Config holds only
 *                     the token's SHA-256 and the scope it owns, so the scope
 *                     is stable across model-key rotation and the config is
 *                     not a secret.
 *  - jwtIdentity      a JWT from your identity provider (JWKS or HS256),
 *                     verified with jose; the scope comes from its claims.
 *  - trustedHeader    an authenticating gateway in front: the gateway holds
 *                     the server secret and names the user in a header.
 *  - sharedSecret     the pre-0.16 single A2A_SERVER_SECRET, kept as a
 *                     migration bridge with exactly its old scoping.
 *  - firstOf          tries authenticators in order (e.g. callers, then the
 *                     shared secret while callers move over).
 *
 * A resolver returns undefined for a request that is not its own: the server
 * answers 401. The scope key is opaque to the framework (ADR 0017 item 3).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { Request } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

import type { RequestIdentity } from './app.ts';
import { deriveUserId } from './executor.ts';

/** One header value: an end-user id, a caller name, a scope segment. */
export const HEADER_VALUE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
/** A whole scope key: segments joined by '/'. */
export const SCOPE_KEY_PATTERN = /^[A-Za-z0-9._/-]{1,160}$/;

/** What the agent card declares for an authenticator. */
export type IdentityScheme =
  | { type: 'bearer'; description: string; bearerFormat?: string }
  | { type: 'header'; name: string; description: string };

export interface Authenticator {
  resolveRequest: (req: Request) => RequestIdentity | undefined | Promise<RequestIdentity | undefined>;
  identityScheme: IdentityScheme;
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice(7).trim();
  return token || undefined;
}

/** X-User-Id when sent and valid; null when sent and invalid (refuse). */
function endUserId(req: Request): string | undefined | null {
  const raw = req.headers['x-user-id'] as string | undefined;
  if (raw === undefined || raw === '') return undefined;
  return HEADER_VALUE_PATTERN.test(raw) ? raw : null;
}

/**
 * A claim or header value as one scope segment. A value that already fits is
 * used as-is (readable in the database); anything else — `auth0|123`, an
 * email address — becomes `h-` plus 32 hex chars of its SHA-256, so two
 * distinct values never collapse into one scope.
 */
export function scopeSegment(value: string): string {
  if (HEADER_VALUE_PATTERN.test(value) && !value.startsWith('h-')) return value;
  return `h-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

// ── Caller tokens ────────────────────────────────────────────────────────────

export interface CallerEntry {
  /** The caller's name, for logs. */
  name: string;
  /** SHA-256 of the caller's bearer token, 64 hex chars. */
  tokenSha256: string;
  /** The scope this caller owns. Default: its name. */
  scope: string;
}

/** SHA-256 hex of a caller token — what A2A_CALLERS stores. */
export function hashCallerToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Parses A2A_CALLERS: entries separated by ';' or newlines, each
 * `name:sha256hex` or `name:sha256hex:scope`. Throws on a malformed entry,
 * a duplicate name or a duplicate token: a half-read caller list must stop
 * the server, not quietly lock a caller out.
 */
export function parseCallers(spec: string): CallerEntry[] {
  const entries: CallerEntry[] = [];
  for (const raw of spec.split(/[;\n]/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [name, hash, scope, ...rest] = line.split(':').map((s) => s.trim());
    if (rest.length || !name || !hash) throw new Error(`A2A_CALLERS: "${line.slice(0, 40)}" is not name:sha256[:scope]`);
    if (!HEADER_VALUE_PATTERN.test(name)) throw new Error(`A2A_CALLERS: caller name "${name}" must match [A-Za-z0-9._-]{1,64}`);
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`A2A_CALLERS: caller "${name}" needs the token's SHA-256 (64 hex chars), not the token`);
    const owned = scope || name;
    if (!SCOPE_KEY_PATTERN.test(owned)) throw new Error(`A2A_CALLERS: caller "${name}" has an invalid scope`);
    if (entries.some((e) => e.name === name)) throw new Error(`A2A_CALLERS: caller "${name}" is listed twice`);
    if (entries.some((e) => e.tokenSha256 === hash.toLowerCase())) throw new Error(`A2A_CALLERS: caller "${name}" reuses another caller's token`);
    entries.push({ name, tokenSha256: hash.toLowerCase(), scope: owned });
  }
  if (entries.length === 0) throw new Error('A2A_CALLERS lists no callers');
  return entries;
}

/**
 * One bearer token per calling backend. The scope is the caller's own; an
 * X-User-Id the caller sends nests beneath it (`<scope>/<user>`), so a
 * caller can reach its own end users and nobody else's. Callers sharing a
 * scope share data — that is how a deployment keeps an existing silo.
 */
export function callerTokens(callers: CallerEntry[]): Authenticator {
  const table = callers.map((c) => ({ ...c, digest: Buffer.from(c.tokenSha256, 'hex') }));
  return {
    identityScheme: { type: 'bearer', description: 'This caller’s own token, issued by the server operator.' },
    resolveRequest(req) {
      const token = bearerToken(req);
      if (!token) return undefined;
      const digest = createHash('sha256').update(token).digest();
      // Compare against every entry: the time taken does not say which matched.
      let found: (typeof table)[number] | undefined;
      for (const c of table) if (timingSafeEqual(digest, c.digest)) found = c;
      if (!found) return undefined;
      const user = endUserId(req);
      if (user === null) return undefined;
      return {
        scopeKey: user ? `${found.scope}/${user}` : found.scope,
        caller: found.name,
        ownsNested: !user,
      };
    },
  };
}

// ── JWT ──────────────────────────────────────────────────────────────────────

export interface JwtIdentityOptions {
  /** Your identity provider's JWKS endpoint (RS256/ES256/EdDSA). */
  jwksUrl?: string;
  /** A shared HS256 secret, instead of a JWKS. At least 32 characters. */
  secret?: string;
  /** Required `iss`. */
  issuer: string | string[];
  /** Required `aud`. */
  audience: string | string[];
  /** The claim naming the user. Default `sub`. */
  scopeClaim?: string;
  /** A claim naming the tenant; the scope is then `<tenant>/<user>`. */
  tenantClaim?: string;
  /** Allowed clock skew, seconds. Default 30. */
  clockToleranceSec?: number;
  /** For tests: a key resolver in place of jwksUrl/secret. */
  getKey?: JWTVerifyGetKey;
}

/**
 * A JWT from your identity provider, verified with jose: signature, `iss`,
 * `aud` and `exp` are required. The scope is the user claim, under the
 * tenant claim when one is configured. X-User-Id is ignored — the token is
 * the user.
 */
export function jwtIdentity(opts: JwtIdentityOptions): Authenticator {
  if (!opts.issuer || !opts.audience) throw new Error('jwtIdentity: issuer and audience are required');
  if (!opts.getKey && !opts.jwksUrl === !opts.secret) throw new Error('jwtIdentity: set exactly one of jwksUrl or secret');
  if (opts.secret && opts.secret.length < 32) throw new Error('jwtIdentity: an HS256 secret must be at least 32 characters');
  const key: JWTVerifyGetKey | Uint8Array =
    opts.getKey ?? (opts.jwksUrl ? createRemoteJWKSet(new URL(opts.jwksUrl)) : new TextEncoder().encode(opts.secret));
  const algorithms = opts.secret && !opts.getKey ? ['HS256'] : undefined;
  const scopeClaim = opts.scopeClaim ?? 'sub';
  const claim = (payload: JWTPayload, name: string): string | undefined => {
    const v = payload[name];
    return typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : undefined;
  };
  return {
    identityScheme: { type: 'bearer', bearerFormat: 'JWT', description: 'A JWT from the deployment’s identity provider.' },
    async resolveRequest(req) {
      const token = bearerToken(req);
      if (!token || token.split('.').length !== 3) return undefined;
      const verifyOpts = {
        issuer: opts.issuer,
        audience: opts.audience,
        requiredClaims: ['exp'],
        clockTolerance: opts.clockToleranceSec ?? 30,
        ...(algorithms ? { algorithms } : {}),
      };
      const { payload } =
        typeof key === 'function' ? await jwtVerify(token, key, verifyOpts) : await jwtVerify(token, key, verifyOpts);
      const user = claim(payload, scopeClaim);
      if (!user) throw new Error(`token has no "${scopeClaim}" claim`);
      const tenant = opts.tenantClaim ? claim(payload, opts.tenantClaim) : undefined;
      if (opts.tenantClaim && !tenant) throw new Error(`token has no "${opts.tenantClaim}" claim`);
      return {
        scopeKey: tenant ? `${scopeSegment(tenant)}/${scopeSegment(user)}` : scopeSegment(user),
        caller: tenant ? `jwt:${scopeSegment(tenant)}` : 'jwt',
        ownsNested: false,
      };
    },
  };
}

// ── Trusted gateway header ───────────────────────────────────────────────────

/**
 * Behind a gateway that authenticates users and forwards the user in a
 * header. Safe ONLY with the server secret configured too: the bearer check
 * runs first, so only the gateway (which holds the secret) can set the
 * header. createA2AApp refuses this authenticator without a serverSecret.
 */
export function trustedHeader(opts: { header: string }): Authenticator {
  const name = opts.header.toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error(`trustedHeader: "${opts.header}" is not a header name`);
  return {
    identityScheme: { type: 'header', name: opts.header, description: 'Set by the authenticating gateway in front of this server.' },
    resolveRequest(req) {
      const raw = req.headers[name];
      if (typeof raw !== 'string' || !raw.trim()) return undefined;
      return { scopeKey: scopeSegment(raw.trim()), caller: 'gateway', ownsNested: false };
    },
  };
}

// ── The pre-0.16 shared secret, as a migration bridge ───────────────────────

/**
 * The single A2A_SERVER_SECRET with exactly its old scoping: the key-hash
 * silo in byok (`a2a-<hash>[/<user>]`), X-User-Id (else `default`) in
 * server mode. Listed after callerTokens so un-migrated callers keep
 * working, then removed once every caller has its own token.
 */
export function sharedSecret(opts: { secret: string; keyMode: 'server' | 'byok' }): Authenticator {
  const expected = createHash('sha256').update(opts.secret).digest();
  return {
    identityScheme: { type: 'bearer', description: 'The server secret (A2A_SERVER_SECRET).' },
    resolveRequest(req) {
      const token = bearerToken(req);
      if (!token || !timingSafeEqual(createHash('sha256').update(token).digest(), expected)) return undefined;
      const user = endUserId(req);
      if (user === null) return undefined;
      if (opts.keyMode === 'byok') {
        const apiKey = req.headers['x-api-key'] as string | undefined;
        if (!apiKey) return undefined;
        return {
          scopeKey: deriveUserId({ apiKey, siteUserId: user }),
          caller: 'shared-secret',
          ownsNested: !user,
        };
      }
      return { scopeKey: user ?? 'default', caller: 'shared-secret', ownsNested: false };
    },
  };
}

/** The first authenticator that recognises the request wins. */
export function firstOf(...authenticators: Authenticator[]): Authenticator {
  if (authenticators.length === 0) throw new Error('firstOf: no authenticators');
  return {
    identityScheme: authenticators[0].identityScheme,
    async resolveRequest(req) {
      let firstError: unknown;
      for (const a of authenticators) {
        try {
          const identity = await a.resolveRequest(req);
          if (identity) return identity;
        } catch (err) {
          // Invalid for this authenticator (an expired JWT, say): try the next,
          // and report the reason if none accepts the request.
          firstError ??= err;
        }
      }
      if (firstError) throw firstError;
      return undefined;
    },
  };
}
