---
type: tool
title: Web tools
description: "Reading the open web: deterministic page extraction as a contract, beside the provider-native search sentinels."
tags:
  - tools
  - web
generated:
  by: process:wiki-build
  at: 2026-09-25
sources:
  - resource: lib/tools/webExtractTool.ts
  - resource: lib/tools/webSearchTool.ts
  - resource: lib/tools/xApiSearchTool.ts
---

# Web tools

<!-- wiki:fill slot="overview" -->
Search and extract are complements. `web_search` runs on the provider's side and returns the snippets the provider chose — it finds. `web_extract` runs here, fetches the URLs the agent chose, and returns the whole page as clean text — it reads past the headline. A research agent searches to find sources and extracts to read them.

Because the agent picks the URL, `web_extract` is the framework's main outbound surface. Every hop, redirects included, passes `lib/net/addressGuard.ts`: only http(s); local names and private, loopback and link-local addresses in every encoding the URL parser emits are refused; and the host name is resolved and refused when any address it resolves to is non-public. The same guard covers MCP servers and remote A2A agents. DNS rebinding between the check and the connection is the stated remaining limit.
<!-- /wiki:fill -->

<!-- wiki:generated section="contracts" source="lib/tools/webExtractTool.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `web_extract` | `urls`, `offset?` | Read web pages in full. |
| `x_api_search` | `query?`, `post?`, `days?`, `sort?`, `max_results?`, `read_images?` | Search X (Twitter) posts from the last 7 days through the X API and read the pictures. |
<!-- /wiki:generated -->

`web_search`, `x_search`, and `collections_search` are not contracts — they are sentinels that enable each provider's native server-side search (see [provider routing](/models/provider-routing.md)). Only `web_extract` executes client-side, which is why it alone runs keyless on local models.

The same X API also serves one route that no agent calls: `POST /v1/x-packet` (`lib/tools/xPacket.ts`, served by the A2A server behind `A2A_SERVER_SECRET` — refused with 403 on a server without one). It takes `{"tickers": [...]}` and answers with a deterministic chatter packet: per cashtag, the last 24h's post count against the median of the five days before (from `/2/tweets/counts/recent`, which returns counts rather than posts), an `unusual` flag (`X_PACKET_MIN_POSTS`, `X_PACKET_SPIKE_RATIO`), and top posts ranked by engagement only for the loudest unusual names (`X_PACKET_MAX_NAMES`, `X_PACKET_POSTS_READ`, `X_PACKET_TOP_POSTS`, `X_PACKET_TRUSTED_HANDLES` first). No model runs and no picture is read: the packet is input for an operator's own desk, and a name with 0 posts is a measured silence rather than a search that found nothing.
