/**
 * A2A demo client — talks to a Melchizedek A2A server with native fetch
 * (no dependencies). It reads the agent card, then sends two messages in ONE
 * conversation so you can see the session carry over.
 *
 *   npm run start:a2a            # in one terminal (or: npx melchizedek-serve <file>.yaml)
 *   node demo/a2a_demo.mjs       # in another
 *
 * Environment (read from the shell, then ./.env):
 *   A2A_URL             base URL of the server   (default http://localhost:4000)
 *   A2A_SERVER_SECRET   the server's bearer secret, when it has one
 *   GOOGLE_GENAI_API_KEY / GEMINI_API_KEY   your model key — sent as X-API-Key
 *                       only when the server's card asks for one (BYOK mode)
 */
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env read from the current directory; the shell wins.
try {
  const envPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.trim().match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m || process.env[m[1]]) continue;
      const val = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (val && !/^your[_-].*[_-]here$/i.test(val)) process.env[m[1]] = val;
    }
  }
} catch {
  // no .env — the shell environment is enough
}

const BASE = (process.env.A2A_URL || 'http://localhost:4000').replace(/\/a2a\/jsonrpc$/, '').replace(/\/$/, '');
const API_KEY = process.env.GOOGLE_GENAI_API_KEY || process.env.GEMINI_API_KEY;
const SECRET = process.env.A2A_SERVER_SECRET;

const headers = {
  'Content-Type': 'application/json',
  ...(SECRET ? { Authorization: `Bearer ${SECRET}` } : {}),
};

/** One message in a conversation. `contextId` belongs INSIDE `message`. */
async function send(text, contextId) {
  const body = {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: {
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        contextId,
        parts: [{ kind: 'text', text }],
      },
    },
  };
  const res = await fetch(`${BASE}/a2a/jsonrpc`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  const task = data.result;
  const answer = task?.status?.message?.parts?.map((p) => p.text).join('') ?? '';
  return { state: task?.status?.state, answer };
}

async function main() {
  console.log(`Server: ${BASE}\n`);

  const cardRes = await fetch(`${BASE}/.well-known/agent-card.json`, { headers: SECRET ? { Authorization: `Bearer ${SECRET}` } : {} });
  if (!cardRes.ok) throw new Error(`agent card: HTTP ${cardRes.status} ${await cardRes.text()}`);
  const card = await cardRes.json();
  console.log(`Agent: ${card.name} — ${card.description}`);
  // A server in BYOK mode declares the X-API-Key scheme: the caller's key
  // funds its inference. Otherwise the server's own keys pay.
  if (card.securitySchemes?.apiKey) {
    if (!API_KEY) throw new Error('this server bills inference to the caller: set GOOGLE_GENAI_API_KEY');
    headers['X-API-Key'] = API_KEY;
  }
  console.log(`Skills: ${(card.skills ?? []).map((s) => s.name).join(', ') || '(none)'}\n`);

  const contextId = `demo-${crypto.randomUUID()}`;
  const first = await send('Hello! Please tell me a one-line joke.', contextId);
  console.log(`[${first.state}] ${first.answer}\n`);
  const second = await send('Explain the joke you just told in one sentence.', contextId);
  console.log(`[${second.state}] ${second.answer}\n`);
  console.log('The second answer refers to the first: same contextId, same session.');
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  console.error('\nIs the server running? Start it from the project root with `npm run start:a2a`');
  console.error('(or `npx melchizedek-serve <file>.yaml` in a project that installed the package).');
  process.exit(1);
});
