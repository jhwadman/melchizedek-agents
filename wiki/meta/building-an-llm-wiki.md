---
type: guide
title: Building an LLM wiki
description: How this bundle is built — what the machine owns, what you own, the ten steps of one build, the second graph over the same files, the two gates, and the recipe for standing one up over your own repo.
tags:
  - meta
  - guide
  - okf
generated:
  by: claude-code/claude-fable-5
  at: 2026-08-19
sources:
  - resource: scripts/wiki_build.ts
  - resource: lib/wiki/builder.ts
  - resource: lib/wiki/entities.ts
---

# Building an LLM wiki

A knowledge base costs you two kinds of work. The first is writing: reading the system, working out what is true, saying it plainly. The second is bookkeeping: adding the new page to its index, fixing the link when a file moves, restating a table that changed shape, remembering which paragraphs went stale when the schema did. Writing is the work you wanted. Bookkeeping is the work that arrives every time anyone touches anything, and it is what kills wikis, because nobody ever has an hour for it.

Karpathy's LLM-wiki pattern is the response: hand the bookkeeping to a program and keep the writing. This bundle does that. Sixty documents, fifteen thousand words, a hundred and eighty links, zero broken and zero orphaned, and no person has ever typed an index entry or a log line. Here is exactly how, so you can run the same loop over your own repo.

## What the machine owns and what you own

Open any generated document here and you will see three kinds of text living together.

Some of it is a table of an agent team's models and tools. A program wrote that by reading the YAML the team is defined in, and a program rewrites it on every build. If you edit it by hand your edit disappears, which is correct: the YAML is where that fact lives, and a second copy would start lying the moment someone changed the first.

Some of it is a paragraph explaining why that team exists and when to run it. A model wrote that once, into a slot the build left empty for it, and every later build steps around it.

The rest is ordinary prose that a person wrote, and the build never touches it at all.

The regions are marked in the file itself, with `wiki:generated` around machine-owned text and `wiki:fill` around the slot. Those markers are how the build knows where its own hands may go.

> **The refresh law.** A rebuild rewrites what it generated, preserves everything else, and stamps a new date only when the content actually changed.

That last clause is what makes the loop safe to run constantly. The builder renders the document, then compares the result against the file on disk with the timestamp blanked out on both sides. Same content, no write, no new date, no diff. Run the build ten times in a row and the second through tenth report `0 created, 0 updated`. Get in the habit of running it after any change to a source file, because a build that costs you nothing when nothing changed is a build you will actually run.

## Seven rules the system rests on

**The path is the identity.** A concept is `/memory/schema.md`, and a link to it is an ordinary markdown link. The graph needs no database, and the content outlives the tooling that made it: every file renders on GitHub, greps, and diffs.

**Structure is derived, prose is owned.** If a parser can read a fact out of a source file, no one types it. If a fact needs judgment, no program overwrites it.

**A rebuild loses nothing.** Prose survives a year of rebuilds, and the build is idempotent, so "run it again" is always safe advice.

**One gate for every write.** Validation is the only door into the bundle. What comes through it conforms, or it never lands.

**Visibility is a path prefix.** Everything under `/private/` stays in this repo, and lint refuses any public document that links into it. The published bundle is closed by construction, so publishing never depends on anyone remembering ([ADR 0003](/decisions/0003-path-based-visibility.md)).

**Derived facts and asserted facts carry different labels.** A derived fact names the file it was read from. An asserted fact carries the sentence that justifies it and the name of whoever made it ([ADR 0005](/decisions/0005-entity-graph-layer.md)).

**The engine takes no dependencies.** The parser is three hundred lines written for the questions this bundle asks, which keeps both this repo and the public mirror free of a markdown toolchain ([ADR 0002](/decisions/0002-zero-dep-structural-engine.md)).

## What one build does

`npm run wiki:build` runs ten steps in a fixed order.

1. **Load the bundle.** Walk every markdown file, parse each into frontmatter, headings, links and markers, check the frontmatter against the format profile, resolve every link to a full bundle path. Nothing is cached between runs; the files on disk are the only truth.
2. **Count the graph once.** Derive the entity graph without writing it, so the document that reports the graph's size can print today's number instead of yesterday's.
3. **Read repo truth into specs.** One spec per derived document: agent teams from their YAML, tool tables from the schemas that define the tools, the database document from the DDL files, provider routing from the model registry. A spec is frontmatter plus an ordered list of parts.
4. **Write each spec into its document.** New file, render it whole. Existing file, refresh it: lift out the prose already sitting in the fill slots, merge the spec's frontmatter over what is on disk so hand-added fields survive, rewrite each generated block between its markers, put the lifted prose back.
5. **Rebuild every index.** Each directory's index lists its own children; the root index lists the sections and leaves out the private annex.
6. **Fill the empty slots, if you asked for it.** `--fill` hands each empty slot's hint to a model and records the model's own name as the document's author. A reply that arrives truncated leaves the slot empty rather than saving half a sentence.
7. **Rebuild both graphs.** The document graph from the links, the entity graph from repo truth, then merge in the asserted relations and write the snapshot.
8. **Lint, then report.** Conformance, link integrity, index coverage, staleness, the closure rules, then the graph's own rules, then the census.
9. **Log one line** if anything changed.
10. **Try the reading planner** on a task with a known good answer, so a broken scorer fails the build instead of quietly returning worse reading plans for months.

## The second graph

Links between documents answer one question well: what should I read next. Ask a different question, though. Which teams call `web_search`? What stops working if `XAI_API_KEY` goes missing? You can read every document in the bundle and still be reduced to grep, because the subjects of those questions are tools and keys, and tools and keys are not documents.

So a second graph sits over the same files. Its nodes are the things the system is made of: agent teams and the agents inside them, the models those agents run on, the providers that serve those models, tools, MCP endpoints, source modules, database tables, environment variables, npm entrypoints. Its edges say what holds between them, with a name on each edge. Today that graph carries 317 nodes and 719 relations over the same 60 documents, and it answers the key question in one call: `XAI_API_KEY` is required by the xAI provider, which serves `grok-4.5`, which one agent in the model zoo runs on.

Most of those relations are **derived**. A scanner reads an import statement, a `CREATE TABLE`, a quoted table name, an environment read, a script command, a YAML field. Derived relations are thrown away and rebuilt on every build, which is why they cannot go stale. A scanner reports what it read and nothing else, so what it cannot see, it never guesses at.

The rest are **asserted**. Some relations live only in prose: this decision constrains that pipeline, this mechanism exists to contain that failure, these two documents have drifted into contradiction. A person or an agent reads the prose and records one relation, with the sentence that supports it and their own name attached. The build never touches those.

> **The tier rule.** Never assert what the build derives. A hand-written copy of a derived fact freezes on the day it was written, and its source moves on without it.

When you extend the graph, start by asking whether a parser could have found the relation. If it could, teach the scanner instead, and get every instance of it for free.

## The two gates

Both write paths refuse rather than repair, and a refusal tells you what to fix.

Saving a document runs parse, profile validation, lint with errors blocking, a path-jailed write, an index refresh and a log entry. An agent's worst case here is mediocre prose, which the advisories surface and git reverts.

Asserting a relation runs its own checks: the relation must be one of the seven that need judgment, both endpoints must exist as nodes, the pair must not already be recorded, and a public document may not point into the private annex. Evidence is required by the schema, so an assertion without a quotation cannot be made at all.

Building the second gate taught the system something about the first. Every accepted assertion appends a line to the log naming both endpoints, and the log at the bundle root is a published file. The first seeding run wrote the name of a private agent team into it, and the export scan caught the name on the next build. A log summary is public text like any other, and the fix generalizes: an entry that names a private document or entity now goes to the annex's own log, which the export never copies.

> **The privacy law.** Every artifact the export copies is public, including the ones the machine writes about itself.

## What this design does not close

The snapshot is only as fresh as the last build, so `wiki_graph` reports its own staleness and names the documents added since. Treat a staleness note as an instruction to rebuild.

The scanners are literal. An import assembled from a variable and a table name built at runtime are both invisible to them, and both stay invisible rather than being guessed at. If your repo does that often, the derived tier will under-report and you should say so in your own version of this document.

Trust runs on an honour system with one honest signal. Most of this bundle is machine-produced and reads as `unverified` until a person adds a `verified` entry with their own name. Nothing enforces review; the frontmatter only makes the absence of review visible.

The public mirror receives the engine and the tools, and it does not receive the build script that derives melchizedek's own documents. There, `wiki_graph` serves whatever snapshot the bundle carries and says plainly when it carries none.

## Build one over your own repo

The engine is bundle-agnostic. Point `WIKI_ROOT` at any conformant directory and the same tools serve it.

1. **Scaffold a bundle.** `npm run wiki:init` writes the root index, the log, and the reserved-file conventions into a fresh directory.
2. **Check what you already have.** `WIKI_ROOT=<path> npm run wiki:check` lints any existing docs directory against the format. Most hand-maintained doc sets come back with warnings rather than errors, and the warnings are the migration list.
3. **Write your own build script.** This is the only part that is yours. It names your sources and maps each to a document spec; parse, refresh, index, lint, graph and log are the shared engine. Keep the script private if it names things you do not publish.
4. **Split generated from prose deliberately.** Anything you would otherwise have to remember to update belongs in a generated block. Anything a program would flatten belongs in prose.
5. **Write the scanners your stack deserves.** The ones here read TypeScript imports, environment reads, SQL and npm scripts. A Python service wants different readers, and the relation vocabulary is a short table you edit.
6. **Seed the judgment once.** Read your own prose end to end and assert the relations no parser could have found. [Gardening](/meta/gardening.md) covers the discipline; the [Cartographers](/agents/cartographers.md) do it conversationally.

Start with step two today. Run the check against the docs directory you already have, read the warning list, and you will know within a minute how far your existing knowledge sits from a bundle that maintains itself.
