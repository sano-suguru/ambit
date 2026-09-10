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
  // Surfaced by `node scripts/bench-corpus.ts` over `test/corpus/corpus.json`:
  // `Headers.set`, `Headers.delete`, `Headers.append`, `URLSearchParams.append`,
  // `FormData.append` and `Uint8Array.set` together account for the WHATWG
  // half of that measurement's `builtin-method` names. Each writes through the
  // receiver, so the locality rule can answer for it; the readers on the same
  // types are in `src/stubs/pure-builtins.ts`.
  //
  // `Object.assign`, `Object.freeze`, `Object.defineProperty`, `Reflect.set`
  // and `Reflect.deleteProperty` also surfaced and are deliberately in neither
  // table: they mutate an *argument*, and the locality rule reads the receiver,
  // which for them is the `Object` / `Reflect` global. It would answer a
  // question about the wrong value.
  "Headers.append",
  "Headers.delete",
  "Headers.set",
  "URLSearchParams.append",
  "URLSearchParams.delete",
  "URLSearchParams.set",
  "URLSearchParams.sort",
  "FormData.append",
  "FormData.delete",
  "FormData.set",
  "Uint8Array.copyWithin",
  "Uint8Array.fill",
  "Uint8Array.reverse",
  "Uint8Array.set",
  "Uint8Array.sort",
]);

export function isMutatingBuiltin(qualifiedName: string): boolean {
  return MUTATING_BUILTINS.has(qualifiedName);
}
