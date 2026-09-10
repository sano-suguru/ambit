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

/**
 * Default-lib functions whose mutation target is their **first argument**, not
 * their receiver: `Object.assign(target, …)` writes into `target`, and
 * `Object` is only where the function is spelled.
 *
 * They need their own table because {@link MUTATING_BUILTINS}'s locality rule
 * reads the receiver. Applied there, these would ask about the `Object` /
 * `Reflect` global and answer `state_write` every time — including for the
 * `Object.assign({}, …)` that appears in almost every codebase, where the
 * target is a value the function just allocated. DESIGN.md §4.2 states the
 * rule in terms that already cover this: "The decision looks at the **root**
 * of the mutation target". For these names that root is in the arguments.
 *
 * Every entry mutates argument 0 and nothing else, which is why one set is
 * enough. `Reflect.apply` and `Object.groupBy` are not here: they call what
 * they are handed, which is a different question and stays `unknown`.
 */
const FIRST_ARGUMENT_MUTATORS: ReadonlySet<string> = new Set([
  "ObjectConstructor.assign",
  "ObjectConstructor.defineProperties",
  "ObjectConstructor.defineProperty",
  "ObjectConstructor.freeze",
  "ObjectConstructor.preventExtensions",
  "ObjectConstructor.seal",
  "ObjectConstructor.setPrototypeOf",
  "Reflect.defineProperty",
  "Reflect.deleteProperty",
  "Reflect.set",
  "Reflect.setPrototypeOf",
]);

export function isMutatingBuiltin(qualifiedName: string): boolean {
  return MUTATING_BUILTINS.has(qualifiedName);
}

/** Whether this default-lib name writes into its first argument rather than its receiver. */
export function isFirstArgumentMutator(qualifiedName: string): boolean {
  return FIRST_ARGUMENT_MUTATORS.has(qualifiedName);
}
