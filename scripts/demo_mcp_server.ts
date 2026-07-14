/**
 * scripts/demo_mcp_server.ts — a small MCP server for the Lyceum Librarian demo.
 *
 * WHY this file exists:
 *   config/agents/librarian.yaml demonstrates the point of MCP: an agent whose
 *   capabilities are not compiled in but DISCOVERED — the framework dials this
 *   server (lib/tools/mcpToolFactory.ts), lists its tools, and hands them to
 *   the Librarian subagent as live ADK tools. This server is the "site" whose
 *   data the agent can then fetch and modify autonomously.
 *
 *   The dataset is a library catalog (demo/library.json). It exposes two read
 *   tools and two WRITE tools, because agency is the lesson: the agent doesn't
 *   just look things up, it changes state on the far side of the protocol.
 *
 * RUN:  npm run mcp:demo         (listens on http://localhost:8931/sse)
 * Then: npm run syndicate:librarian   (needs ALLOW_PRIVATE_MCP=true in .env —
 *       the SSRF guard refuses loopback hosts unless explicitly allowed)
 *
 * DESIGN NOTES:
 *   - Low-level Server API (setRequestHandler + JSON-Schema tool definitions)
 *     rather than the zod-based McpServer sugar, so the file has zero
 *     dependencies beyond the MCP SDK and express — both already present.
 *   - SSE transport, to match what mcpToolFactory's SSEClientTransport dials.
 *   - Writes persist to demo/library.json so a second session sees the first
 *     session's borrows and notes — state, not theater.
 */

import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const PORT = Number(process.env.MCP_DEMO_PORT ?? 8931);
const CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'demo',
  'library.json',
);

// ── The catalog ───────────────────────────────────────────────────────────────

interface Scroll {
  id: string;
  title: string;
  author: string;
  topic: string;
  summary: string;
  status: 'available' | 'borrowed';
  borrower: string | null;
  notes: string[];
}

const SEED: Scroll[] = [
  {
    id: 'scroll-001',
    title: 'On the Soul of Machines',
    author: 'Theophrastus the Younger',
    topic: 'philosophy of mind',
    summary:
      'Asks whether an instrument that predicts speech can be said to understand it; concludes the question belongs to the builder, not the instrument.',
    status: 'available',
    borrower: null,
    notes: ['Margin note: compare with the confabulation lesson.'],
  },
  {
    id: 'scroll-002',
    title: 'The Delegation Contracts',
    author: 'Xenia of Miletus',
    topic: 'orchestration',
    summary:
      'A treatise on dividing labor among specialists: who must be consulted, in what order, and why the description of a helper is a promise.',
    status: 'available',
    borrower: null,
    notes: [],
  },
  {
    id: 'scroll-003',
    title: 'Records of the Hearth',
    author: 'anonymous',
    topic: 'memory',
    summary:
      'Household ledgers demonstrating that what is worth remembering is decided at the moment of writing, not the moment of recall.',
    status: 'borrowed',
    borrower: 'Philon',
    notes: ['Borrowed for the memory-systems seminar.'],
  },
  {
    id: 'scroll-004',
    title: 'The Protocol of Open Doors',
    author: 'Kallias the Cartographer',
    topic: 'protocols',
    summary:
      'Argues that a city grows by standardizing its gates, not by widening its walls; a map of interfaces between strangers who never meet.',
    status: 'available',
    borrower: null,
    notes: [],
  },
];

function loadCatalog(): Scroll[] {
  if (!existsSync(CATALOG_PATH)) {
    writeFileSync(CATALOG_PATH, JSON.stringify(SEED, null, 2) + '\n');
  }
  return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Scroll[];
}

function saveCatalog(catalog: Scroll[]): void {
  writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2) + '\n');
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

// ── The MCP server ────────────────────────────────────────────────────────────

function buildServer(): Server {
  const server = new Server(
    { name: 'lyceum-library-catalog', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'search_catalog',
        description:
          'Search the library catalog by words from a title, author, or topic. Returns matching scrolls with id, title, author, and status.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Words to match against title, author, and topic.',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_scroll',
        description:
          'Read one scroll\'s full catalog record — summary, status, borrower, and reader notes — by its id (e.g. "scroll-002").',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The scroll id.' },
          },
          required: ['id'],
        },
      },
      {
        name: 'borrow_scroll',
        description:
          'Borrow an available scroll for a named reader, or return it (pass borrower: "") — this MODIFIES the catalog.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The scroll id.' },
            borrower: {
              type: 'string',
              description:
                'The reader borrowing the scroll; an empty string returns it.',
            },
          },
          required: ['id', 'borrower'],
        },
      },
      {
        name: 'annotate_scroll',
        description:
          'Append a reader note to a scroll\'s catalog record — this MODIFIES the catalog.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The scroll id.' },
            note: { type: 'string', description: 'The note to append.' },
          },
          required: ['id', 'note'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const catalog = loadCatalog();

    switch (name) {
      case 'search_catalog': {
        const q = String(args.query ?? '').toLowerCase();
        const hits = catalog.filter((s) =>
          [s.title, s.author, s.topic].some((f) =>
            f.toLowerCase().includes(q),
          ),
        );
        if (hits.length === 0) return text(`No scrolls match "${q}".`);
        return text(
          hits
            .map((s) => `${s.id} · "${s.title}" — ${s.author} [${s.status}]`)
            .join('\n'),
        );
      }
      case 'read_scroll': {
        const s = catalog.find((x) => x.id === args.id);
        if (!s) return text(`No scroll with id "${args.id}".`);
        return text(JSON.stringify(s, null, 2));
      }
      case 'borrow_scroll': {
        const s = catalog.find((x) => x.id === args.id);
        if (!s) return text(`No scroll with id "${args.id}".`);
        const borrower = String(args.borrower ?? '').trim();
        if (borrower === '') {
          s.status = 'available';
          s.borrower = null;
        } else {
          if (s.status === 'borrowed') {
            return text(
              `Refused: "${s.title}" is already borrowed by ${s.borrower}.`,
            );
          }
          s.status = 'borrowed';
          s.borrower = borrower;
        }
        saveCatalog(catalog);
        return text(
          `Updated: ${s.id} is now ${s.status}${s.borrower ? ` (borrower: ${s.borrower})` : ''}.`,
        );
      }
      case 'annotate_scroll': {
        const s = catalog.find((x) => x.id === args.id);
        if (!s) return text(`No scroll with id "${args.id}".`);
        s.notes.push(String(args.note ?? ''));
        saveCatalog(catalog);
        return text(`Updated: ${s.id} now carries ${s.notes.length} note(s).`);
      }
      default:
        return text(`Unknown tool: ${name}`);
    }
  });

  return server;
}

// ── Express + SSE wiring ──────────────────────────────────────────────────────
// One transport per SSE session; POSTed messages are routed back to their
// session by the sessionId query parameter the transport hands the client.

const app = express();
const transports = new Map<string, SSEServerTransport>();

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

app.listen(PORT, () => {
  console.log(
    `Lyceum library catalog (MCP) listening on http://localhost:${PORT}/sse`,
  );
  console.log(`Catalog data: ${CATALOG_PATH}`);
});
