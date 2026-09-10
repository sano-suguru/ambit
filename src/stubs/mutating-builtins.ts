/**
 * Allowlist of default-lib (builtin) methods that change their receiver in
 * place. Keyed the same way as `src/stubs/pure-builtins.ts` — `checker.
 * getFullyQualifiedName()`'s format (e.g. `"Array.push"`, `"Map.set"`) — and
 * kept in a separate table from it because the two answer different
 * questions: that one says "no `KnownEffect` at all", this one says "a
 * `state_write` if the receiver is reachable from outside the function"
 * (DESIGN.md §4.2, "Local mutation and `pure`").
 *
 * Whether a listed call actually produces `state_write` is decided per call
 * site by the receiver's locality, not by this table: mutating a value the
 * function itself allocated is not observable outside it, so it carries no
 * effect. The locality rule lives in `src/checker/backend/legacy-ts.ts`
 * (`isLocallyOwnedMutationTarget`).
 *
 * Admission rule, same as `pure-builtins.ts`: names that `ambit check
 * --coverage`'s `top-unresolved-names` actually surfaced, plus the in-place
 * siblings on the same builtin type — a table that listed `push` but not
 * `pop` would mislead the next reader. When unsure, leave a name out; it
 * falls back to `unknown`, which over-approximates rather than under-.
 */
const MUTATING_BUILTINS: ReadonlySet<string> = new Set([
  // Surfaced by `check src --coverage` on 2026-09-09: Array.push=50,
  // Map.set=13, Set.add=6 — together 69 of the 131 `builtin-method`
  // unresolved calls, which is what made this table worth having.
  "Array.push",
  "Array.pop",
  "Array.shift",
  "Array.unshift",
  "Array.splice",
  "Array.sort",
  "Array.reverse",
  "Array.fill",
  "Array.copyWithin",
  "Map.set",
  "Map.delete",
  "Map.clear",
  "Set.add",
  "Set.delete",
  "Set.clear",
  "WeakMap.set",
  "WeakMap.delete",
  "WeakSet.add",
  "WeakSet.delete",
]);

export function isMutatingBuiltin(qualifiedName: string): boolean {
  return MUTATING_BUILTINS.has(qualifiedName);
}
