/**
 * Allowlist of default-lib (builtin) methods known to perform none of
 * Ambit's `KnownEffect`s — no network, filesystem, process, database, LLM,
 * or env access — regardless of arguments. Keyed by `checker.
 * getFullyQualifiedName()`'s format (e.g. `"Set.has"`, `"Array.map"`), a
 * different namespace from `src/stubs/node-builtins.ts`'s module-specifier
 * keys (e.g. `"node:fs.readFileSync"`) — the two tables are never merged or
 * compared (`src/core/backend.ts`'s `CallSite.pureBuiltinName` doc comment).
 * In-place mutation is a separate table, `src/stubs/mutating-builtins.ts`
 * (DESIGN.md §4.2, "Local mutation and `pure`"): a mutator's effect depends on
 * its receiver, so it cannot be answered by a name alone the way this table
 * answers. Nondeterminism beyond `env` is still outside the model; this
 * allowlist claims only "no `KnownEffect`", not "pure" in a stricter sense.
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
 * (DESIGN.md §4.2 rule 4: a higher-order call's callback effects must be
 * inferred from the actual argument, never treated as complete from the
 * type signature alone).
 *
 * Populated from what measurement actually surfaces on real code, not written
 * ahead of evidence. DESIGN.md §4.2 fixes the admission rule: "Only names that
 * showed up in measurements, and their in-place-mutation sibling methods on the
 * same builtin type, are listed; when in doubt, not listed." The measurement is
 * `node scripts/bench-corpus.ts` over the fixed corpus in
 * `test/corpus/corpus.json`, plus `ambit check --coverage` on Ambit's own
 * source. When unsure, leave a name out — it just falls back to `unknown`,
 * which is safe.
 *
 * Three kinds of name the corpus surfaced are deliberately **not** here,
 * because no honest verdict was available for them:
 *
 * - names that mutate an *argument* rather than the receiver
 *   (`Object.assign`, `Object.freeze`, `Object.defineProperty`,
 *   `Reflect.set`, `Reflect.deleteProperty`). The locality rule in
 *   `src/checker/backend/legacy-ts.ts` decides from the receiver, which for
 *   these is the `Object` / `Reflect` global — it would answer a question
 *   about the wrong value, so `src/stubs/mutating-builtins.ts` cannot take
 *   them either;
 * - names whose effect depends on what the object is backed by
 *   (`Body.json`, `Response.json`, a `ReadableStream`'s reader and
 *   controller, `SubtleCrypto`). A `Response` body can be a socket;
 *   "in-memory data movement" is an assumption, not a reading of the code;
 * - `Console.log` and its siblings, which write to a stream Ambit's effect
 *   table has no name for. Calling them `pure` would say the process left no
 *   trace.
 */
/** `<type>.<member>` keys for one builtin type, so each group below reads as the member list it is. */
function members(type: string, names: readonly string[]): readonly string[] {
  return names.map((name) => `${type}.${name}`);
}

/**
 * `Array`'s non-mutating members. Shared with `ReadonlyArray`, which the
 * checker names separately for the same call depending on the receiver's
 * declared type.
 */
const ARRAY_READERS: readonly string[] = [
  "at", "concat", "entries", "every", "filter", "find", "findIndex", "findLast",
  "findLastIndex", "flat", "flatMap", "forEach", "includes", "indexOf", "join",
  "keys", "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some",
  "toLocaleString", "toReversed", "toSorted", "toSpliced", "toString", "values",
  "with",
];

/** Every `String` member: a string is immutable, so all of them are readers. */
const STRING_READERS: readonly string[] = [
  "at", "charAt", "charCodeAt", "codePointAt", "concat", "endsWith", "includes",
  "indexOf", "isWellFormed", "lastIndexOf", "localeCompare", "match",
  "matchAll", "normalize", "padEnd", "padStart", "repeat", "replace",
  "replaceAll", "search", "slice", "split", "startsWith", "substring",
  "toLocaleLowerCase", "toLocaleUpperCase", "toLowerCase", "toString",
  "toUpperCase", "toWellFormed", "trim", "trimEnd", "trimStart", "valueOf",
];

/** The readers `Map` and `Set` share. Their mutators are in the mutating table. */
const COLLECTION_READERS: readonly string[] = [
  "entries",
  "forEach",
  "get",
  "has",
  "keys",
  "values",
];

/**
 * `Date`'s readers. Every one of them reads the instance it is called on, not
 * the clock — the clock is `new Date()` with no argument and `Date.now()`, both
 * of which are `env`.
 */
const DATE_READERS: readonly string[] = [
  "getDate", "getDay", "getFullYear", "getHours", "getMilliseconds",
  "getMinutes", "getMonth", "getSeconds", "getTime", "getTimezoneOffset",
  "getUTCDate", "getUTCDay", "getUTCFullYear", "getUTCHours",
  "getUTCMilliseconds", "getUTCMinutes", "getUTCMonth", "getUTCSeconds",
  "toDateString", "toISOString", "toJSON", "toLocaleDateString",
  "toLocaleString", "toLocaleTimeString", "toString", "toTimeString",
  "toUTCString", "valueOf",
];

/**
 * Grouped by the builtin type the name belongs to. Every group is complete for
 * the non-mutating members of that type as of ES2023 plus the WHATWG types the
 * corpus surfaced — the sibling half of §4.2's rule — so that a reader can tell
 * an intentional omission (the three kinds listed above) from an accident of
 * which method a particular measurement happened to hit.
 */
const PURE_BUILTINS: ReadonlySet<string> = new Set([
  // -- Array ------------------------------------------------------------
  // Mutators (`push`, `sort`, `splice`, ...) are `src/stubs/mutating-builtins.ts`'s.
  ...members("Array", ARRAY_READERS),
  ...members("ReadonlyArray", ARRAY_READERS),
  ...members("ArrayConstructor", ["isArray", "from", "fromAsync", "of"]),
  ...members("ArrayBufferConstructor", ["isView"]),

  // -- Object -----------------------------------------------------------
  // `assign`, `freeze`, `seal`, `defineProperty`, `defineProperties`,
  // `preventExtensions` and `setPrototypeOf` mutate the *argument*; see the
  // file comment for why neither table can take them.
  ...members("ObjectConstructor", [
    "create",
    "entries",
    "fromEntries",
    "getOwnPropertyDescriptor",
    "getOwnPropertyDescriptors",
    "getOwnPropertyNames",
    "getOwnPropertySymbols",
    "getPrototypeOf",
    "groupBy",
    "hasOwn",
    "is",
    "isExtensible",
    "isFrozen",
    "isSealed",
    "keys",
    "values",
  ]),
  ...members("Object", [
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
  ]),

  // -- String -----------------------------------------------------------
  // A `String` is immutable, so every member is a reader.
  ...members("String", STRING_READERS),
  ...members("StringConstructor", ["fromCharCode", "fromCodePoint", "raw"]),

  // -- Number / Math ----------------------------------------------------
  ...members("Number", ["toExponential", "toFixed", "toLocaleString", "toPrecision", "toString", "valueOf"]),
  ...members("NumberConstructor", [
    "isFinite",
    "isInteger",
    "isNaN",
    "isSafeInteger",
    "parseFloat",
    "parseInt",
  ]),
  // `Math.random` is left out on purpose: DESIGN.md §4.2 lists randomness
  // under `env`, so it is an effect, not the absence of one
  // (`src/stubs/builtin-effects.ts`).
  ...members("Math", [
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atan2", "atanh", "cbrt",
    "ceil", "clz32", "cos", "cosh", "exp", "expm1", "floor", "fround", "hypot",
    "imul", "log", "log10", "log1p", "log2", "max", "min", "pow", "round",
    "sign", "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
  ]),
  ...members("BigInt", ["toLocaleString", "toString", "valueOf"]),

  // -- JSON / RegExp ----------------------------------------------------
  ...members("JSON", ["parse", "stringify"]),
  // `exec` and `test` advance `lastIndex` on a `/g` regex. That is a mutation
  // of the regex object, not one of Ambit's `KnownEffect`s, and this table
  // claims only the latter (see the head comment).
  ...members("RegExp", ["exec", "test", "toString"]),

  // -- Map / Set / WeakMap / WeakSet ------------------------------------
  ...members("Map", COLLECTION_READERS),
  ...members("ReadonlyMap", COLLECTION_READERS),
  ...members("Set", COLLECTION_READERS),
  ...members("ReadonlySet", COLLECTION_READERS),
  ...members("WeakMap", ["get", "has"]),
  ...members("WeakSet", ["has"]),

  // -- Promise ----------------------------------------------------------
  // Registering a continuation performs no effect of its own; the callback's
  // effects are the callback's, and an opaque one passed by reference is
  // refused by `callbackByReference` before this table is consulted
  // (DESIGN.md §4.2 rule 4).
  ...members("Promise", ["then", "catch", "finally"]),
  ...members("PromiseConstructor", [
    "all",
    "allSettled",
    "any",
    "race",
    "reject",
    "resolve",
    "withResolvers",
  ]),

  // -- Date -------------------------------------------------------------
  // Readers of an existing instance only. `Date.now()` reads the clock and is
  // `env` (`src/stubs/builtin-effects.ts`), as `new Date()` already was.
  ...members("Date", DATE_READERS),

  // -- Function ---------------------------------------------------------
  // `bind` builds a new callable and invokes nothing. `call` and `apply` do
  // invoke, so they are left out: they are a call to a function this table
  // cannot see.
  ...members("CallableFunction", ["bind"]),
  ...members("Function", ["toString"]),

  // -- WHATWG types the corpus surfaced ---------------------------------
  // Readers only; `set` / `append` / `delete` are in the mutating table.
  ...members("Headers", ["entries", "forEach", "get", "getSetCookie", "has", "keys", "values"]),
  ...members("URLSearchParams", [
    "entries",
    "forEach",
    "get",
    "getAll",
    "has",
    "keys",
    "toString",
    "values",
  ]),
  ...members("URL", ["toJSON", "toString"]),
  ...members("FormData", ["entries", "forEach", "get", "getAll", "has", "keys", "values"]),
  ...members("TextEncoder", ["encode"]),
  ...members("TextDecoder", ["decode"]),
  // `Uint8Array` is the only typed array the corpus surfaced. `set`, `fill`,
  // `sort`, `reverse` and `copyWithin` write through the receiver and are in
  // the mutating table.
  ...members("Uint8Array", [
    "at", "entries", "every", "filter", "find", "findIndex", "findLast",
    "findLastIndex", "forEach", "includes", "indexOf", "join", "keys",
    "lastIndexOf", "map", "reduce", "reduceRight", "slice", "some", "subarray",
    "toString", "values",
  ]),
]);

/**
 * Globals called as a bare identifier (`Number(x)`, `parseInt(s)`), which reach
 * `src/checker/summarize.ts` in the *other* name namespace —
 * `CallSite.calleeQualifiedName`, the module-specifier one — because
 * `qualifiedNameOf` can name a bare identifier from the source text alone.
 *
 * A textual name is not on its own evidence that the global is the builtin: a
 * project could declare its own `Number`. It is only consulted when the
 * connector layer already classified the call as `builtin-method`, which means
 * the callee resolved to a declaration in TypeScript's own default lib. That is
 * what makes matching by name honest here, and it is why this set is separate
 * from {@link PURE_BUILTINS} rather than merged into it.
 *
 * `Function` is deliberately absent: `Function(body)` compiles a string, which
 * DESIGN.md §4.2 rule 6 makes `unknown` — the same verdict `new Function` gets.
 * So are `setTimeout` / `queueMicrotask` and friends, which run a callback the
 * analysis never enters.
 */
const PURE_GLOBAL_CALLS: ReadonlySet<string> = new Set([
  // Primitive conversion.
  "BigInt",
  "Boolean",
  "Number",
  "String",
  "Symbol",
  // Numeric parsing and classification.
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  // URI encoding.
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  // Error construction. Called with or without `new`, these allocate a value
  // and capture a stack; nothing outside the process observes it.
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  // Structured cloning is a deep copy of its argument.
  "structuredClone",
]);

export function isKnownPureBuiltin(qualifiedName: string): boolean {
  return PURE_BUILTINS.has(qualifiedName);
}

/**
 * Whether a bare-identifier call this connector layer already resolved to
 * TypeScript's default lib performs none of Ambit's `KnownEffect`s. Keyed in
 * `CallSite.calleeQualifiedName`'s namespace — see {@link PURE_GLOBAL_CALLS}.
 */
export function isKnownPureGlobalCall(qualifiedName: string): boolean {
  return PURE_GLOBAL_CALLS.has(qualifiedName);
}
