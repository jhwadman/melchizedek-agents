---
type: tool
title: Web tools
description: "Reading the open web: deterministic page extraction as a contract, beside the provider-native search sentinels."
tags:
  - tools
  - web
generated:
  by: process:wiki-build
  at: 2026-08-09
sources:
  - resource: lib/tools/webExtractTool.ts
  - resource: lib/tools/webSearchTool.ts
---

# Web tools

<!-- wiki:fill slot="overview" -->
_TODO(fill): why search (server-side, provider-chosen snippets) and extract (client-side, agent-chosen URLs) are complements — search to find, extract to read past the headline_
<!-- /wiki:fill -->

<!-- wiki:generated section="contracts" source="lib/tools/webExtractTool.ts" -->
| Tool | Arguments | Does |
|---|---|---|
| `web_extract` | `urls`, `offset?` | Read web pages in full. |
<!-- /wiki:generated -->

`web_search`, `x_search`, and `collections_search` are not contracts — they are sentinels that enable each provider's native server-side search (see [provider routing](/models/provider-routing.md)). Only `web_extract` executes client-side, which is why it alone runs keyless on local models.
