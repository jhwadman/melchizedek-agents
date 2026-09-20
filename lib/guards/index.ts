/**
 * lib/guards/index.ts — post-answer guards, resolved by NAME from a syndicate's
 * `guards:` list the way tools are resolved from `tools:`.
 *
 * A guard runs in scripts/a2a_server.ts after the answering turn and before
 * the reply is published. It receives the final text and every tool-result
 * text that turn produced, and returns the text to ship plus notes for the
 * `[STATUS]` stream. It never re-asks a model: at temperature 0 the same
 * prompt returns the same sentence, so a guard that fires annotates in place.
 *
 * Names, not module paths: a YAML that could name an arbitrary file to load
 * is a code-loading vector. Adding a guard is a deliberate act here.
 *
 * PUBLIC BUILD. This is the overlay copy, and it ships the guard INTERFACE with
 * an empty registry — the same arrangement lib/toolRegistry.ts uses to publish
 * its shape without its private tool families. The guards this deployment runs
 * are domain modules that stay in the private repo, so a public syndicate that
 * names one gets the ordinary "Unknown guard — ignored" warning rather than a
 * module that does not exist. Register your own by adding it to GUARD_MAP.
 */

export interface GuardResult {
  text: string;
  notes: string[];
}

export interface Guard {
  name: string;
  run(text: string, toolResultTexts: string[]): Promise<GuardResult>;
}

// Null-prototype so a name like `toString` cannot resolve off Object.prototype
// and skip the unknown-guard warning.
const GUARD_MAP: Record<string, Guard> = Object.create(null);

export function resolveGuards(names: string[] = [], onUnknown?: (name: string) => void): Guard[] {
  return names
    .map((name) => {
      const guard = Object.prototype.hasOwnProperty.call(GUARD_MAP, name)
        ? GUARD_MAP[name]
        : undefined;
      if (!guard) { onUnknown?.(name); return null; }
      return guard;
    })
    .filter((g): g is Guard => g !== null);
}
