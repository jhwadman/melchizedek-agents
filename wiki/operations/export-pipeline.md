---
type: runbook
title: Export pipeline
description: How the sanitized public mirror is generated — file allowlist, overlay rewrites, drift-hardened patches, forbidden-term and secret scans, destination tests — and why it never pushes.
tags:
  - operations
  - export
generated:
  by: claude-code/claude-fable-5
  at: 2026-07-26
sources:
  - resource: scripts/export-public/export.sh
---

# Export pipeline

`bash scripts/export-public/export.sh` regenerates the sibling public repo from this one. Never edit the destination by hand — its `.melchizedek-export` marker says so; the fix is always upstream + re-export ([the network doctrine](/overview/lyceum-network.md)).

Three layers, applied in order:

1. **Allowlist** — a flat array of file paths in the script. Publishing a file = adding its path there: a deliberate act, reviewable as one diff line. Five private syndicates, the private market-data tool layer, and this bundle's `/private/` subtree are simply never listed.
2. **Patches** — surgical text rewrites, hard-failing on drift or ambiguity: if upstream changes under a patch, the export dies rather than silently shipping the wrong text.
3. **Overlay** — public-only files (README, QUICKSTART, DOCUMENTATION, AGENT_SETUP, package.json, the public tool registry) copied last, overwriting anything allowlisted. The overlay package.json is its own contract: an allowlisted file's dependencies must exist there too.

Then the gates: a forbidden-term scan (names of private systems must not appear anywhere in the destination), a secret scan (key-shaped strings, stray `.env`), `npm install && npm test` **in the destination**, and finally a commit tagged with the source short-SHA. **The script never pushes — publishing stays a human act.**

## The wiki subtree

This knowledge bundle exports as a directory copy of `wiki/` that **excludes `/private/`**. The bundle's own lint makes that safe before the scans ever run: no public document may link into `/private/` ([decision 0003](/decisions/0003-path-based-visibility.md)), so the published bundle is link-closed by construction, and gardening a public doc never requires touching the export script.
