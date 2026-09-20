/**
 * scripts/wiki/mcp_server.ts — the knowledge bundle, served over MCP.
 *
 * WHY this file exists:
 *   The wiki's whole tool surface (lib/tools/wikiTools.ts) reaches outside
 *   clients here — Claude Code, an IDE, another agent dialing SSE. Same
 *   contracts the syndicate agents use, schemas DERIVED from zod, nothing
 *   hand-written: define once, serve anywhere.
 *
 * RUN:  npm run mcp:wiki           (listens on http://localhost:8933/sse)
 * Try:  point any MCP client at the /sse URL, or a melchizedek agent via
 *       mcp_server_url (needs ALLOW_PRIVATE_MCP=true in .env — the SSRF
 *       guard refuses loopback hosts unless explicitly allowed).
 *
 * DESIGN NOTES:
 *   - EXPOSED is the deliberate act of exposure. It includes the write path
 *     (wiki_save, wiki_garden): a knowledge bundle you cannot write to is a
 *     brochure, and every write is gated by lint, jailed to the bundle, and
 *     logged in log.md — with git as the undo. Serve WIKI_AGENT_TOOL_CONTRACTS
 *     instead if a deployment wants a read-only wiki.
 *   - wiki_query / wiki_garden run a model IN THIS PROCESS: they need a
 *     provider key in the server's environment (see WIKI_AGENT_MODEL in
 *     lib/config.ts) and return a clear error string when none is set. The
 *     navigation tools never touch a model.
 *   - Loopback only and unauthenticated, like the other MCP servers here:
 *     never bind wider without putting real authentication in front.
 */

import { loadEnv } from '../../lib/loadEnv.ts';
import { serveContracts } from '../../lib/tools/mcpServe.ts';
import { WIKI_TOOL_CONTRACTS } from '../../lib/tools/wikiTools.ts';
import { resolveWikiRoot } from '../../lib/wiki/vault.ts';

loadEnv(import.meta.url);

serveContracts({
  name: 'melchizedek-wiki',
  label: 'wiki',
  port: Number(process.env.MCP_WIKI_PORT ?? 8933),
  // The deliberate act: only contracts listed here are reachable over MCP.
  contracts: WIKI_TOOL_CONTRACTS,
  startupLines: () => [`Bundle root: ${resolveWikiRoot()}`],
});
