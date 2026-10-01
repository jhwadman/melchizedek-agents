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

`x_api_search` reads X through the X API v2 recent search: one page of the last seven days per call, each post verbatim with handle, date, metrics and URL. It is a boolean keyword match, not a semantic search. Passing an x.com status link or id as `post` reads that one post. Each attached photo is fetched only from the API's media host and transcribed beneath its post by a Gemini vision pass; `read_images: false` turns that off. It needs `X_BEARER_TOKEN` in the server environment, and `X_API_MAX_RESULTS` can lower the page size. Without the token it returns an UNAVAILABLE line instead of throwing.

`web_search`, `x_search`, and `collections_search` are not contracts — they are sentinels that enable each provider's native server-side search (see [provider routing](/models/provider-routing.md)). `web_extract` and `x_api_search` execute client-side, so they work on any provider; `web_extract` alone needs no key and runs on local models.

A route no agent calls (a deployment's own HTTP endpoint over the same X API, say) does not belong in the engine: a deployment mounts it through `createA2AApp`'s `routes` option, or `startServer(name, { routes })` from `melchizedek-agents/server`, and checks `currentRequestContext().operator` when only operator credentials may spend the quota behind it.
