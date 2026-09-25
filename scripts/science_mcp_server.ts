/**
 * scripts/science_mcp_server.ts — the clinical-evidence tool contracts, served over MCP.
 *
 * WHY this file exists:
 *   Proof of the tool-contract layer (lib/tools/toolContract.ts): the SAME seven
 *   definitions the evidence syndicates consume as ADK FunctionTools are
 *   served here to any MCP client — Claude, an IDE, someone's own app dialing
 *   SSE — with the tools/list schemas DERIVED from the zod contracts, not
 *   hand-written. Define once, serve anywhere; if a schema changes in
 *   scienceTools.ts, both surfaces change together.
 *
 * RUN:  npm run mcp:science       (listens on http://localhost:8934/sse)
 * Try:  point any MCP client at the /sse URL, or a melchizedek agent via
 *       mcp_server_url (needs ALLOW_PRIVATE_MCP=true in .env — the SSRF
 *       guard refuses loopback hosts unless explicitly allowed).
 *
 * DESIGN NOTES:
 *   - The SSE/express scaffold lives in lib/tools/mcpServe.ts, shared with the
 *     other contract servers. It was copied into all three, and the copies
 *     had already drifted apart on `isError` and on whether they read .env.
 *   - `contracts` below is the deliberate act of exposure: only what is listed
 *     there is served. All seven science tools are read-only literature and
 *     registry fetches (Europe PMC, ClinicalTrials.gov, Crossref, OpenAlex) —
 *     nothing here mutates state.
 *   - Loopback only and unauthenticated, like the demo server: never bind
 *     wider without putting real authentication in front.
 */

import { loadEnv } from '../lib/loadEnv.ts';
import { serveContracts } from '../lib/tools/mcpServe.ts';
import { SCIENCE_TOOL_CONTRACTS } from '../lib/tools/scienceTools.ts';

// Without this nothing populates process.env, so SCIENCE_API_CONTACT sits
// unread in .env and every source call goes out as "no contact set" — which is
// not an error, just the throttled pool, silently.
loadEnv(import.meta.url);

// 8931 demo, 8933 wiki, 8934 science. This defaulted to 8933,
// so `npm run mcp:wiki` and `npm run mcp:science` could not both run: the
// second died with EADDRINUSE, and a client pointed at localhost:8933 got
// whichever server won the race answering tools/list for the wrong surface.
serveContracts({
  name: 'melchizedek-science-tools',
  label: 'science tools',
  port: Number(process.env.MCP_SCIENCE_PORT ?? 8934),
  // The deliberate act: only contracts listed here are reachable over MCP.
  contracts: SCIENCE_TOOL_CONTRACTS,
});
