/**
 * lib/guards/index.ts — post-answer guards, resolved by NAME from a syndicate's
 * `guards:` list the way tools are resolved from `tools:`.
 *
 * A guard runs after the answering turn and before the reply ships
 * (lib/runtime/syndicateTurn.ts — the server, REPL, worker and evals alike). It receives the final text and every tool-result
 * text that turn produced, and returns the text to ship plus notes for the
 * `[STATUS]` stream. It never re-asks a model: at temperature 0 the same
 * prompt returns the same sentence, so a guard that fires annotates in place.
 *
 * Names, not module paths: a YAML that could name an arbitrary file to load
 * is a code-loading vector. Adding a guard is a deliberate act here.
 *
 * It ships the guard interface and one
 * guard, `science` (lib/guards/science.ts), which research.yaml runs: identifier
 * closure, a retraction check, and name correspondence over the answer. Any
 * other guard a syndicate names gets the ordinary "Unknown guard — ignored"
 * warning. Register your own by adding it to GUARD_MAP.
 */

import { IdLedger, runGuards } from './science.ts';

export interface GuardResult {
  text: string;
  notes: string[];
}

export interface Guard {
  name: string;
  run(text: string, toolResultTexts: string[]): Promise<GuardResult>;
}

const scienceGuard: Guard = {
  name: 'science',
  async run(text, toolResultTexts) {
    const ledger = new IdLedger();
    for (const t of toolResultTexts) ledger.noteFromToolText(t);
    const report = await runGuards(text, ledger);
    // runGuards annotates the answer and NOTES any work whose retraction lookup
    // could not be completed, so a failed lookup never reads as a clean bill.
    return { text: report.answer, notes: report.notes };
  },
};

// Null-prototype so a name like `toString` cannot resolve off Object.prototype
// and skip the unknown-guard warning.
const GUARD_MAP: Record<string, Guard> = Object.assign(Object.create(null), {
  science: scienceGuard,
});

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

/**
 * Make a guard resolvable by name from a syndicate's `guards:` list — for
 * package consumers, the same deliberate act as adding it to GUARD_MAP
 * above, done in their own code. Replacing a built-in requires
 * `{ override: true }`.
 */
export function registerGuard(guard: Guard, options: { override?: boolean } = {}): void {
  if (!guard || typeof guard.run !== 'function' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(guard.name ?? '')) {
    throw new Error('registerGuard: a guard needs a valid name and a run(text, toolResultTexts) function');
  }
  if (Object.prototype.hasOwnProperty.call(GUARD_MAP, guard.name) && !options.override) {
    throw new Error(`registerGuard: '${guard.name}' is already registered (pass { override: true } to replace it)`);
  }
  GUARD_MAP[guard.name] = guard;
}
