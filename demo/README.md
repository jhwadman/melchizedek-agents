# Calling a Melchizedek syndicate over A2A

This folder holds a zero-dependency client for the A2A (Agent-to-Agent) server. Any HTTP client can talk to a syndicate: requests are JSON-RPC 2.0 over a plain `POST`.

## 1. Start the server

From the project root:

```bash
npm run start:a2a
```

In a project that installed the package, run `npx melchizedek-serve <file>.yaml` instead. The boot log prints the card URL, the endpoints, the auth mode and whether sessions are durable.

## 2. Run the client

```bash
node demo/a2a_demo.mjs
```

It reads the agent card, then sends two messages in one conversation, so the second answer shows the session carrying over. Set `A2A_URL` to point it elsewhere, `A2A_SERVER_SECRET` when the server has one, and `GOOGLE_GENAI_API_KEY` for the model key.

## The request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "kind": "message",
      "messageId": "<uuid>",
      "role": "user",
      "contextId": "<conversation id>",
      "parts": [{ "kind": "text", "text": "Hello!" }]
    }
  }
}
```

Headers: `Content-Type: application/json`, `X-User-Id: <your app's user id>`, and `Authorization: Bearer <A2A_SERVER_SECRET>` when the server has a secret (or this caller's own token when the server runs `A2A_AUTH=callers`). A server in BYOK mode (`A2A_KEY_MODE=byok`) also needs `X-API-Key: <your model key>`; its card says so.

`contextId` goes **inside** `message`. Every call with the same value continues one conversation (one session). A `contextId` placed beside `message` is ignored by the protocol, and each call then starts a new session.

The reply is a task. `result.status.state` is `completed`, `failed`, `canceled` or `rejected`, and `result.status.message.parts[0].text` is the answer. For long runs, send with `"configuration": { "blocking": false }`, poll `tasks/get` with the task id, or use `message/stream` for progress events; `tasks/cancel` stops a running task.

## With the official SDK

`@a2a-js/sdk` 1.x speaks A2A 1.0 and, with `legacyCompat`, 0.3. The server
serves both, so either works:

```typescript
import { Role } from '@a2a-js/sdk';
import { ClientFactory, DefaultAgentCardResolver, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

const auth = (url: string | URL | Request, init?: RequestInit) =>
  fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), Authorization: `Bearer ${process.env.A2A_SERVER_SECRET}`, 'X-User-Id': 'user-1' } });
const legacyCompat = { enabled: true };
const card = await new DefaultAgentCardResolver({ fetchImpl: auth, legacyCompat }).resolve('http://localhost:4000');
const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl: auth, legacyCompat })] }).createFromAgentCard(card);

const result = await client.sendMessage({
  tenant: '',
  message: {
    messageId: crypto.randomUUID(), contextId: 'conv-1', taskId: '', role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: 'Hello!' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  },
  configuration: undefined,
  metadata: undefined,
});
```

`lib/a2a/remoteAgent.ts` is a complete client built this way (it adds the
SSRF guard and per-host credentials), and `tests/a2aServer.test.ts` exercises
both protocol versions against a live server.
