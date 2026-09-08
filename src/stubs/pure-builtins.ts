/**
 * Allowlist of default-lib (builtin) methods known to perform none of
 * Ambit's `KnownEffect`s — no network, filesystem, process, database, LLM,
 * or env access — regardless of arguments. Keyed by `checker.
 * getFullyQualifiedName()`'s format (e.g. `"Set.has"`, `"Array.map"`), a
 * different namespace from `src/stubs/node-builtins.ts`'s module-specifier
 * keys (e.g. `"node:fs.readFileSync"`) — the two tables are never merged or
 * compared (`src/core/backend.ts`'s `CallSite.pureBuiltinName` doc comment).
 * Mutation and nondeterminism are outside Ambit's effect model for now
 * (DESIGN.md §12); this allowlist claims only "no `KnownEffect`", not "pure"
 * in a stricter sense.
 *
 * This exists because `qualifiedNameOf` (`src/checker/backend/legacy-ts.ts`)
 * cannot produce a textual name for a builtin method reached through a local
 * value (`set.has(...)`, `arr.map(...)`) — there is no import binding to read
 * a module specifier from. `checker.getFullyQualifiedName()` still resolves
 * a stable name from the symbol itself, so those calls are named, but a
 * *name* is not a *pure* verdict: only entries listed here are trusted.
 *
 * A method that can take a callback (`map`, `forEach`, `filter`, `some`,
 * ...) may still list a symbol reached by reference (`arr.forEach(handler)`)
 * — the connector layer marks that call `callbackByReference` and
 * `summarize.ts`'s `toCall` refuses to treat it as pure even if the method
 * name is listed here, because an opaque callback might do anything
 * (DESIGN.md §4.2 rule 4, "呼び出し元が渡す引数由来のコールバック").
 *
 * Populated from what `ambit check --coverage`'s `top-unresolved-names`
 * actually surfaces on real code, not written ahead of evidence. When
 * unsure, leave a name out — it just falls back to `unknown`, which is safe.
 */
const PURE_BUILTINS: ReadonlySet<string> = new Set([
  // Confirmed against `ambit check --coverage`'s top-unresolved-names on
  // Ambit's own source (2026-09-08). Deliberately excludes observed
  // mutating names — `Array.push`, `Array.sort` (in-place), `Map.set`,
  // `Set.add` — even though they carry no `KnownEffect` either; a
  // "pure" table that lists mutators would mislead the next reader.
  "Set.has",
  "Map.get",
  "Map.has",
  "Map.entries",
  "ReadonlyMap.get",
  "ReadonlyMap.has",
  "ReadonlyMap.values",
  "ReadonlyMap.entries",
  "ReadonlySet.has",
  "Array.map",
  "Array.filter",
  "Array.join",
  "Array.slice",
  "Array.reduce",
  "ReadonlyArray.map",
  "ReadonlyArray.filter",
  "ReadonlyArray.some",
  "ReadonlyArray.includes",
  "ReadonlyArray.join",
  "ReadonlyArray.find",
  "String.trim",
  "String.split",
  "String.includes",
  "String.startsWith",
  "String.localeCompare",
  "ObjectConstructor.fromEntries",
  "JSON.stringify",
  "Math.round",
  "Number.toFixed",
]);

export function isKnownPureBuiltin(qualifiedName: string): boolean {
  return PURE_BUILTINS.has(qualifiedName);
}
