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
_TODO(fill): why search (server-side, provider-chosen snippets) and extract (client-side, agent-chosen URLs) are complements — search to find, extract to read past the headline_
<!-- /wiki:fill -->

<!-- wiki:generated section="contracts" source="lib/tools/webExtractTool.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `web_extract` | `urls`, `offset?` | Read web pages in full. |
| `x_api_search` | `query?`, `post?`, `days?`, `sort?`, `max_results?`, `read_images?` | Search X (Twitter) posts from the last 7 days through the X API and read the pictures. |
<!-- /wiki:generated -->

`web_search`, `x_search`, and `collections_search` are not contracts — they are sentinels that enable each provider's native server-side search (see [provider routing](/models/provider-routing.md)). Only `web_extract` executes client-side, which is why it alone runs keyless on local models.

The same X API also serves one route that no agent calls: `POST /v1/x-packet` (`lib/tools/xPacket.ts`, served by the A2A server behind `A2A_SERVER_SECRET` — refused with 403 on a server without one). It takes `{"tickers": [...]}` and answers with a deterministic chatter packet: per cashtag, the last 24h's post count against the median of the five days before (from `/2/tweets/counts/recent`, which returns counts rather than posts), an `unusual` flag (`X_PACKET_MIN_POSTS`, `X_PACKET_SPIKE_RATIO`), and top posts ranked by engagement only for the loudest unusual names (`X_PACKET_MAX_NAMES`, `X_PACKET_POSTS_READ`, `X_PACKET_TOP_POSTS`, `X_PACKET_TRUSTED_HANDLES` first). No model runs and no picture is read: the packet is input for an operator's own desk, and a name with 0 posts is a measured silence rather than a search that found nothing.
