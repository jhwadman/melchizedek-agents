/**
 * lib/tools/mcpServe.ts — serve a list of tool CONTRACTS over MCP.
 *
 * WHY this exists:
 *   Three scripts carried a byte-identical copy of this scaffold —
 *   `scripts/financial_mcp_server.ts`, `scripts/science_mcp_server.ts`,
 *   `scripts/wiki/mcp_server.ts`. `diff` put the financial and science copies
 *   11 lines apart, 6 of those comment prose: the tool list, the port, the
 *   server name. The other ~55 lines (buildServer, the transport map, the rate
 *   limit, the /sse and /messages handlers, the loopback bind) were the same
 *   text three times.
 *
 *   That is the situation lib/toolRegistry.ts was created to end, and its
 *   header records what happens next: "The two copies had already begun to
 *   drift." They had here too — only one of the three set `isError`, and only
 *   one called `loadEnv`, so an MCP client got different failure semantics and
 *   a different environment depending on which server it dialed.
 *
 * NOT `scripts/demo_mcp_server.ts`. That one hand-writes its JSON Schema and
 * its dispatch switch on purpose: it is the teaching contrast that shows what
 * the contract layer removes, and routing it through this helper would delete
 * the thing it exists to demonstrate.
 */

import express from 'express';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { executeContract, toMcpToolDefinition } from './toolContract.ts';
import type { ToolContract } from './toolContract.ts';

export interface ServeContractsOptions {
  /** the MCP server name reported in the handshake */
  name: string;
  /** human label for the startup line, e.g. `science tools` */
  label: string;
  /** bind port; loopback only, always */
  port: number;
  /** THE DELIBERATE ACT OF EXPOSURE: only these contracts are reachable. */
  contracts: readonly ToolContract<any>[];
  /** extra lines printed once listening (the wiki prints its bundle root) */
  startupLines?: () => string[];
  /** requests per minute per client; a ceiling against a runaway loop */
  rateLimitPerMinute?: number;
  /**
   * Whether a contract's returned STRING represents a failure, for MCP's
   * `isError` flag. Contracts never throw — `executeContract` returns
   * validation failures as `Error: …`, and the tool modules return upstream
   * failures as text — so the flag has to be read off the result.
   */
  isFailure?: (result: string) => boolean;
}

/** `Error: invalid arguments…` (executeContract), `Error fetching…`
 *  (the market-data contracts), `… — SOURCE ERROR: …` (scienceTools). */
const defaultIsFailure = (s: string): boolean =>
  /^Error\b/.test(s) || s.includes('— SOURCE ERROR:');

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });
const errorText = (s: string) => ({ ...text(s), isError: true });

export function serveContracts(opts: ServeContractsOptions): void {
  const {
    name,
    label,
    port,
    contracts,
    startupLines,
    rateLimitPerMinute = 240,
    isFailure = defaultIsFailure,
  } = opts;

  const buildServer = (): Server => {
    const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: contracts.map(toMcpToolDefinition),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name: toolName, arguments: args = {} } = req.params;
      const contract = contracts.find((c) => c.name === toolName);
      // `isError` is what lets a client tell "the tool answered" from "the tool
      // failed". Without it an autonomous loop treats an unknown-tool reply and
      // a schema-validation failure as ordinary answers and carries on.
      if (!contract) return errorText(`Unknown tool: ${toolName}`);
      const result = await executeContract(contract, args);
      return isFailure(result) ? errorText(result) : text(result);
    });

    return server;
  };

  // One transport per SSE session; POSTed messages are routed back to their
  // session by the sessionId query parameter the transport hands the client.
  const app = express();
  const transports = new Map<string, SSEServerTransport>();

  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

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

  // Loopback only, deliberately: these servers have no auth, so they must never
  // be reachable from another machine. Put real MCP servers behind real
  // authentication before binding wider.
  app.listen(port, '127.0.0.1', () => {
    console.log(`Melchizedek ${label} (MCP) listening on http://localhost:${port}/sse`);
    for (const line of startupLines?.() ?? []) console.log(line);
    console.log(
      `Serving ${contracts.length} contract-derived tools: ${contracts.map((c) => c.name).join(', ')}`,
    );
  });
}
