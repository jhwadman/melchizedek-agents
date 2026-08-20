---
type: decision
title: 'ADR 0007: The engine ships as an npm package, published from the export'
description: Publish lib/ as the melchizedek-agents package built inside the sanitized public mirror by the existing export pipeline — rather than restructuring the private repo into a workspace monorepo.
tags:
  - decision
  - packaging
status: stable
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-19
sources:
  - resource: scripts/export-public/export.sh
  - resource: lib/loadSyndicate.ts
---

# ADR 0007: The engine ships as an npm package, published from the export

## Context

[ADR 0006](/decisions/0006-starter-pack-split.md) separated the starter pack from live configuration, but a consumer's syndicate still had to live inside a clone of the framework. One sibling repo already consumed the engine the way a package consumer would — importing `lib/` modules by fragile relative path and reimplementing the YAML loader because the path-jail refused to read outside the repo. The demand was proven; the delivery mechanism was missing.

Two shapes were considered: restructure the private repo into npm workspaces with a `packages/engine`, or teach the existing export pipeline to produce a publishable package inside the sanitized public mirror.

## Decision

Publish from the export. The private repo keeps its layout and remains the source of truth; `melchizedek-agents` — the public repo — carries the package manifest in its overlay and is what `npm publish` runs in. This reuses the sanitization machinery wholesale: the allowlist, the overlay, the patches, and the forbidden-term and secret scans all run upstream of packaging, so the package cannot contain what the mirror may not.

Three mechanics follow:

- **The engine is location-independent.** `loadSyndicate` resolves its jail root as option → `MELCHIZEDEK_AGENTS_DIR` → `<cwd>/config/agents`; the wiki root defaults to `<cwd>/wiki` under `WIKI_ROOT`; image tools honor `OUTPUTS_DIR`. Nothing in `lib/` derives paths from its own file location any more.
- **The package compiles; the repo does not.** Node refuses to strip types under `node_modules`, so the overlay carries a `tsconfig.build.json` (`rewriteRelativeImportExtensions`, declarations, `dist/`) — the project's first and only build step, confined to the mirror. Clones keep running `.ts` sources directly.
- **Every export proves the package.** The pipeline builds `dist/`, packs the tarball, installs it into a throwaway consumer, and loads a starter-pack syndicate through the installed package before committing. The exports map in the overlay manifest is the semver boundary; publishing itself stays a human act, like pushing.

## Consequences

The framework has an enforced public API for the first time — what the barrel and subpath exports expose is a versioned contract, and the mirror map gains a step: API-affecting `lib/` changes end in a version bump. The private repo intentionally does not consume the package (it is the source); the sibling that imports `lib/` by relative path migrates to the package after first publish. Divergence between the source-run and compiled-run engine is the standing risk, held down by `isolatedModules` and the pack-and-consume gate in every export.
