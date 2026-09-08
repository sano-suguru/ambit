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

// Bare call to a named import: today's known cross-module resolution gap
// (`getSymbolAtLocation` resolves to the `ImportSpecifier`, not the
// declaration behind it — see `classifyCall`'s "import-binding" comment).
// Fixed by following `checker.getAliasedSymbol()`.
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
