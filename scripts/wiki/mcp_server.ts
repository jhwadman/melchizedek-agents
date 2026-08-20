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

import express from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadEnv } from '../../lib/loadEnv.ts';
import {
  executeContract,
  toMcpToolDefinition,
} from '../../lib/tools/toolContract.ts';
import type { ToolContract } from '../../lib/tools/toolContract.ts';
import { WIKI_TOOL_CONTRACTS } from '../../lib/tools/wikiTools.ts';
import { resolveWikiRoot } from '../../lib/wiki/vault.ts';

loadEnv(import.meta.url);

const PORT = Number(process.env.MCP_WIKI_PORT ?? 8933);

// The deliberate act: only contracts listed here are reachable over MCP.
const EXPOSED: readonly ToolContract<any>[] = WIKI_TOOL_CONTRACTS;

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

// ── The MCP server ────────────────────────────────────────────────────────────

function buildServer(): Server {
  const server = new Server(
    { name: 'melchizedek-wiki', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: EXPOSED.map(toMcpToolDefinition),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const contract = EXPOSED.find((c) => c.name === name);
    if (!contract) return text(`Unknown tool: ${name}`);
    return text(await executeContract(contract, args));
  });

  return server;
}

// ── Express + SSE wiring ──────────────────────────────────────────────────────
// One transport per SSE session; POSTed messages are routed back to their
// session by the sessionId query parameter the transport hands the client.

const app = express();
const transports = new Map<string, SSEServerTransport>();

// 240 requests/min is generous for an agent making a handful of tool
// calls per turn, and a hard ceiling against a runaway loop.
app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));

app.get('/sse', async (_req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports.set(transport.sessionId, transport);
  res.on('close', () => transports.delete(transport.sessionId));
  await buildServer().connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = String(req.query.sessionId ?? '');
  const transport = transports.get(sessionId);
  if (!transport) {
    res.status(400).send('Unknown sessionId');
    return;
  }
  await transport.handlePostMessage(req, res);
});

// Loopback only, deliberately: this server has no auth AND serves a write
// tool, so it must never be reachable from another machine. Put real MCP
// servers behind real authentication before binding wider.
app.listen(PORT, '127.0.0.1', () => {
  console.log(
    `Melchizedek wiki (MCP) listening on http://localhost:${PORT}/sse`,
  );
  console.log(`Bundle root: ${resolveWikiRoot()}`);
  console.log(
    `Serving ${EXPOSED.length} contract-derived tools: ${EXPOSED.map((c) => c.name).join(', ')}`,
  );
});
