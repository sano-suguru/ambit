import * as path from "node:path";
import { helperPureFn } from "./helper.ts";

/** @effects network */
export async function fetchRateDeclared(): Promise<number> {
  const res = await fetch("https://example.com/rate");
  return Number(await res.text());
}

export async function fetchRateUndeclared(): Promise<number> {
  const res = await fetch("https://example.com/rate");
  return Number(await res.text());
}

/** @effects pure */
export function calculateTax(amount: number): number {
  return amount * 0.1;
}

/** @effects pure */
export function calculateTaxViaDeclaredCallee(amount: number): number {
  return amount * (1 + rateFromDeclared());
}

function rateFromDeclared(): number {
  return 0.1;
}

export function callsDynamicImport(): void {
  void import("node:fs");
}

export function callsEval(): void {
  // biome-ignore lint/security/noGlobalEval: fixture data for the "eval" detection rule, never executed
  eval("1 + 1");
}

export function callsUnknownCallback(cb: () => void): void {
  cb();
}

// Bare call to a named import, resolved cross-module via
// `checker.getAliasedSymbol()` (see `classifyCall`).
export function callsImportedFunction(): number {
  return helperPureFn();
}

// A builtin method reached through a local value: `qualifiedNameOf` has no
// name to offer the stub table, but the declaration is TypeScript's own
// default lib.
export function callsBuiltinMethod(): boolean {
  const seen = new Set<number>();
  return seen.has(1);
}

// A property access through a namespace import of a Node.js builtin: the
// declaration lives in @types/node, an external package's .d.ts, and the
// stub table has no entry for "node:path.resolve".
export function callsExternalModule(): string {
  return path.resolve(".");
}

// A builtin method allowlisted in src/stubs/pure-builtins.ts, called with an
// inline callback: collectCalls walks the callback body itself, so the
// method can be trusted as pure.
export function callsPureBuiltinInline(): number[] {
  return [1, 2, 3].map((n) => n * 2);
}

function double(n: number): number {
  return n * 2;
}

// Same allowlisted method ("Array.map"), but the callback is passed by
// reference: collectCalls never walks into `double`'s body, so this call
// must stay unresolved even though the method name itself is allowlisted.
export function callsPureBuiltinByReference(): number[] {
  return [1, 2, 3].map(double);
}

// biome-ignore lint/suspicious/noExplicitAny: fixture data for the any-typed-argument fail-open guard
const anyTypedHandler: any = double;

// An any-typed callback passed by reference has no call signatures of its
// own (getCallSignatures() returns []), so it must still be treated as
// opaque — not mistaken for "not callable" and let through as pure.
export function callsPureBuiltinByReferenceAnyTyped(): number[] {
  return [1, 2, 3].map(anyTypedHandler);
}

// `reduce`'s seed is not a callback slot: its declared parameter type is the
// type parameter `U`, not a function type. A callable seed must not make the
// call look like it takes an opaque callback — the callback here is inline
// and is walked by collectCalls.
/** @effects pure */
export function sumAll(xs: number[]): number {
  return xs.reduce<number>((a, b) => a + b, 0);
}

// Same shape as sumAll, but the seed itself is a callable value (a thunk).
// hasOpaqueCallableArgument must not scan the seed argument just because it
// happens to be callable — it isn't the callback position.
/** @effects pure */
export function foldToThunk(xs: number[]): () => number {
  const seed = () => 0;
  return xs.reduce<() => number>((_acc, x) => () => x, seed);
}
