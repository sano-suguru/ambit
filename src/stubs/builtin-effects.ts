import type { KnownEffect } from "../core/index.ts";

/**
 * Default-lib (builtin) members that perform one of Ambit's `KnownEffect`s.
 * Keyed like `src/stubs/pure-builtins.ts` — `checker.getFullyQualifiedName()`'s
 * format — and kept apart from it because the two answer opposite questions:
 * that table says "no `KnownEffect`", this one names the effect.
 *
 * It exists because the alternative for these names is `unknown`, and `unknown`
 * is the wrong answer when the effect is known exactly. DESIGN.md §4.2 lists
 * "the clock, and randomness" under `env`, and `src/stubs/constructors.ts`
 * already reads `new Date()` that way; a `Date.now()` left `unknown` beside it
 * would be the same operation with two verdicts.
 *
 * Same admission rule as the other two tables (DESIGN.md §4.2): names that
 * measurement surfaced — here `node scripts/bench-corpus.ts` over
 * `test/corpus/corpus.json` — plus the siblings on the same type that are the
 * same kind of operation. Nondeterminism beyond `env` is outside the model, so
 * nothing is listed on a guess about what an operation "probably" touches.
 */
const BUILTIN_EFFECTS: ReadonlyMap<string, KnownEffect> = new Map<string, KnownEffect>([
  ["DateConstructor.now", "env"],
  ["Math.random", "env"],
]);

export function lookupBuiltinEffect(qualifiedName: string): KnownEffect | undefined {
  return BUILTIN_EFFECTS.get(qualifiedName);
}
