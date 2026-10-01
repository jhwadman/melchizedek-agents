---
type: decision
title: 'ADR 0022: This repository becomes the public source of truth; private deployments consume the package'
description: The engine is developed in the open in a fresh-history public repository built by allowlist from this one; private syndicates, tools and deployment live in a private repository that depends on the published package; evals live in their own repository; the export pipeline and the generated mirror are retired.
tags:
  - decision
  - operations
status: stable
generated:
  by: claude-code/claude-opus-5-5
  at: 2026-10-01
sources:
  - resource: README.md
  - resource: package.json
---

# ADR 0022: This repository becomes the public source of truth; private deployments consume the package

## Context

The engine was developed in a private repository and published through a generated mirror. [ADR 0007](/decisions/0007-engine-as-package.md) chose this to avoid restructuring the repository.

It had costs:

- The mirror was overwritten on every export, so an outside pull request could not land, though the README invited them.
- About two-thirds of the tests covering shipped code never reached the public repository.
- The public wiki described tooling adopters could not obtain.
- A deny list let three private syndicates get public pages.
- Public history was a run of "sync" commits with no rationale.

An enterprise adopter expects to read, test and contribute to the source it runs.

## Decision

1. **A new public repository with a fresh history becomes the engine's source of truth.** Development, tests, the wiki and npm publishing of `melchizedek-agents` happen there.
2. **It is assembled by allowlist, never by deleting from a copy.** The last export run writes the sanitised tree into an empty directory, which starts the new history. A history rewrite of this repository would still carry every private file in it.
3. **Private syndicates, private tools, private routes and the live deployment move to a private repository** that depends on the published package. It registers its tools and routes through the plug points ([ADR 0017](/decisions/0017-plug-points.md)).
4. **Evals live in their own repository** and drive the package's exported runner.
5. **The export pipeline, its overlay and the generated mirror are retired.** The mirror is archived with a pointer.
6. **The public wiki is reviewed against the code before publication.** Every page is kept, fixed, moved to private or deleted.

## Alternatives considered

- **Keep the mirror and say "issues only".** Honest, but leaves the test, wiki and contribution gaps.
- **A monorepo with private packages.** Rejected: it keeps private code beside public code in one history, which is the risk being removed.

## Consequences

- Supersedes [ADR 0007](/decisions/0007-engine-as-package.md) on where the package is published from. The exports map stays the semver boundary.
- A deployment's registry-only live copy of a shipped syndicate lives with that deployment, in its private repository.
- [ADR 0003](/decisions/0003-path-based-visibility.md)'s private subtree moves out. The public wiki has no private section.
- The migration order, including the prerequisite plug points, is specified in `plans/public-takeover.md`.
