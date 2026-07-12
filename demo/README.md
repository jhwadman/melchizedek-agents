# Melchizedek A2A (Agent-to-Agent) Protocol Setup

This folder contains a standalone demonstration of how external clients or agents can converse with a Melchizedek Syndicate via the official A2A JSON-RPC Protocol.

## Architecture

Melchizedek supports exposing any syndicate as a stateless API using the A2A Protocol. This integration operates with a strict **Bring-Your-Own-Key (BYOK)** middleware. Instead of keeping a stateful global API key, the server dynamically spins up the ADK Agent Graph on a per-request basis using the credentials you pass in the headers (`X-API-Key` and `X-Provider`). 

Because we use native JSON-RPC 2.0 over standard HTTP POST, external apps do not need heavy SDKs to talk to Melchizedek. A simple `fetch` command is all you need.

## 1. Start the A2A Server

From the root of the `melchizedek` repository, start the A2A exposer server. This will launch a Node Express wrapper on port 4000.

```bash
npm run start:a2a
```

*(You will see `[A2A] Exposer server boot complete on port 4000` when it is ready).*

## 2. Run the Demo Client

We've provided a simple, zero-dependency Node.js script that sends a standard A2A payload to the server.

```bash
node a2a_demo.mjs
```

### What happens under the hood?

The `a2a_demo.mjs` script sends the following JSON-RPC payload to `http://localhost:4000/a2a/jsonrpc`:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "messageId": "<uuid>",
      "role": "user",
      "parts": [{"kind": "text", "text": "Hello! Please tell me a brief joke."}]
    },
    "contextId": "demo-session-001"
  }
}
```

The server intercepts this, validates the `X-API-Key` and `X-Provider: google` headers, launches the Google ADK runner bound to `demo-session-001`, and pipes the agent's textual or thought responses back as standard A2A `message` events in the `result` block.

## Using the Official SDK

While this raw fetch script demonstrates the underlying protocol gracefully, you can also use the official `@a2a-js/sdk` for production clients.

```typescript
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';

const factory = new ClientFactory({
  transports: [new JsonRpcTransportFactory()]
});
const client = await factory.createFromUrl('http://localhost:4000/a2a/jsonrpc');

// Be sure to pass a custom fetch implementation if your setup requires auth headers globally!
const response = await client.sendMessage({ ... });
```
