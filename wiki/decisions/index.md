# Decisions

<!-- wiki:generated section="listing" source="directory contents" -->
- [ADR 0001: Adopt OKF v0.2 as the bundle format](/decisions/0001-okf-profile.md) — The knowledge vault is an Open Knowledge Format bundle — markdown + YAML frontmatter + normal links — under a small local profile, rather than a bespoke wiki format.
- [ADR 0002: Zero-dependency structural markdown engine](/decisions/0002-zero-dep-structural-engine.md) — Parse and build documents with a purpose-built ~300-line structural engine instead of the remark/unified ecosystem; edit surgically by markers, never reserialize prose.
- [ADR 0003: Path-based visibility with a link-closure lint](/decisions/0003-path-based-visibility.md) — Public/private is a subtree property — /private/ never exports — enforced by lint (no public link into /private/, no private names in public docs) before the export scans ever run.
- [ADR 0004: Wiki tool exposure tiers](/decisions/0004-wiki-tool-exposure.md) — Navigation primitives and the gated save go to syndicate agents; the agentic composites (query, garden) are MCP-only; every write passes one validated gate.
- [ADR 0005: An entity layer over the document graph](/decisions/0005-entity-graph-layer.md) — Add typed entities and relations derived from repo truth as a second layer inside the bundle, with judgment asserted separately and evidenced — rather than adopting a parallel graph store.
<!-- /wiki:generated -->
