import type { KnownEffect } from "../core/index.ts";

/**
 * Effect table for `new X(...)`, keyed in its own namespace: every key is the
 * `calleeQualifiedName` of a call site, prefixed by {@link CONSTRUCTOR_KEY_PREFIX}
 * (`"new Date"`, `"new @prisma/client.PrismaClient"`). The prefix keeps
 * construction and plain calls apart — `URL(...)` and `new URL(...)` are not
 * the same operation, and a space cannot occur in the qualified name a call
 * produces, so the two key spaces can never collide.
 *
 * This table exists because before it, `new X(...)` was dropped from the call
 * graph entirely: a function declared `@effects pure` that constructed a
 * database client reported no call at all, not even `unknown`. DESIGN.md §3.4
 * forbids turning an unanalyzed path into "no violation".
 *
 * Trust level: bundled with Ambit ("Ambit 同梱", the highest level in
 * DESIGN.md §8).
 */
export const CONSTRUCTOR_KEY_PREFIX = "new ";

export function constructorStubKey(qualifiedName: string): string {
  return `${CONSTRUCTOR_KEY_PREFIX}${qualifiedName}`;
}

const CONSTRUCTOR_EFFECTS: ReadonlyMap<string, KnownEffect> = new Map([
  ["new node:net.Socket", "network"],
  ["new node:tls.TLSSocket", "network"],
  ["new node:http.Agent", "network"],
  ["new node:https.Agent", "network"],
  ["new WebSocket", "network"],
  ["new node:worker_threads.Worker", "process"],
]);

/**
 * Constructors that read non-deterministic input only when called with no
 * arguments. `new Date()` reads the clock (DESIGN.md §4.2 lists 時刻 under
 * `env`); `new Date(2020, 0, 1)` is a pure conversion of its arguments.
 */
const NULLARY_ONLY_EFFECTS: ReadonlyMap<string, KnownEffect> = new Map([["new Date", "env"]]);

/**
 * Constructors known to perform none of Ambit's `KnownEffect`s. As with
 * `src/stubs/pure-builtins.ts`, this claims "no `KnownEffect`", not purity in
 * a stricter sense — `new Map()` allocates mutable state, which is outside
 * the effect model (DESIGN.md §12).
 *
 * A constructor that takes a callback (`Promise`) is listed here, but the
 * connector layer marks `new Promise(namedExecutor)` `callbackByReference`
 * and `summarize.ts` then refuses the pure verdict — the executor's body was
 * never walked (DESIGN.md §4.2 rule 4).
 */
const PURE_CONSTRUCTORS: ReadonlySet<string> = new Set([
  "new Map",
  "new Set",
  "new WeakMap",
  "new WeakSet",
  "new Array",
  "new Object",
  "new Promise",
  "new RegExp",
  "new Error",
  "new TypeError",
  "new RangeError",
  "new SyntaxError",
  "new EvalError",
  "new ReferenceError",
  "new AggregateError",
  "new URL",
  "new URLSearchParams",
  "new TextEncoder",
  "new TextDecoder",
  "new AbortController",
  "new Number",
  "new String",
  "new Boolean",
  "new Int8Array",
  "new Uint8Array",
  "new Uint8ClampedArray",
  "new Int16Array",
  "new Uint16Array",
  "new Int32Array",
  "new Uint32Array",
  "new Float32Array",
  "new Float64Array",
  "new BigInt64Array",
  "new BigUint64Array",
  "new ArrayBuffer",
  "new DataView",
]);

/**
 * The effect of constructing `qualifiedName` (a {@link constructorStubKey}),
 * or `undefined` when this table says nothing about it — which leaves the
 * call `unknown`, never "no effect".
 *
 * `withoutArguments` distinguishes `new Date()` from `new Date(x)`; pass
 * `true` when the construction has no arguments.
 */
export function lookupConstructorEffect(
  qualifiedName: string,
  withoutArguments: boolean,
): KnownEffect | undefined {
  const always = CONSTRUCTOR_EFFECTS.get(qualifiedName);
  if (always) return always;
  return withoutArguments ? NULLARY_ONLY_EFFECTS.get(qualifiedName) : undefined;
}

/**
 * True when constructing `qualifiedName` is known to have no `KnownEffect`.
 * A nullary-only effect entry (`new Date()`) is excluded when the
 * construction actually is nullary.
 */
export function isKnownPureConstructor(qualifiedName: string, withoutArguments: boolean): boolean {
  if (lookupConstructorEffect(qualifiedName, withoutArguments) !== undefined) return false;
  if (NULLARY_ONLY_EFFECTS.has(qualifiedName)) return true;
  return PURE_CONSTRUCTORS.has(qualifiedName);
}

export function isConstructorKey(qualifiedName: string): boolean {
  return qualifiedName.startsWith(CONSTRUCTOR_KEY_PREFIX);
}
