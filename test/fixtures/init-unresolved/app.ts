// Fixture for `AMB-I002` (DESIGN.md §4.1, §4.2 rule 6): one undeclared
// function per reason a call can go unresolved, so `ambit init` can be
// checked to report *why* no contract can be proposed — while proposing
// nothing, for the same reason §4.1 gives.

import { resolve } from "node:path";
import { readLegacy } from "legacy-store";
import { doesNotExist } from "./no-such-module.ts";

/** A builtin the stub tables do name, so this one is resolvable. */
export function resolvable(values: readonly number[]): number {
  return values.length;
}

export function callsExternalModule(dir: string): string {
  // `node:path.resolve` is declared in `@types/node` under node_modules and is
  // not in the stub table: `external-module`.
  return resolve(dir);
}

export function callsMissingImport(): void {
  // The module specifier follows to no declaration at all: `import-binding`.
  doesNotExist();
}

export function callsProjectAmbient(): string {
  // Declared in this project's own `types/legacy.d.ts`: `ambient-declaration`.
  return readLegacy("k");
}

export function callsBuiltinMethod(when: Date): number {
  // A default-lib method neither bundled table names: `builtin-method`.
  return when.setFullYear(2020);
}

export function callsCallbackParameter(next: () => void): void {
  // §4.2 rule 4: what `next` does is decided by the actual argument.
  next();
}

export function sortsWithCallbackByReference(
  values: number[],
  compare: (a: number, b: number) => number,
): number[] {
  // A mutator handed a callback by reference. The mutation is known; the
  // callback's effects are not (§4.2 rule 4), so the caller is `unknown` with
  // no `UnresolvedCall` anywhere in its body.
  values.sort(compare);
  return values;
}

// biome-ignore lint/suspicious/noExplicitAny: `any` is what this case is about
export function callsAnyTyped(client: any): unknown {
  // §4.2 rule 6: nothing identifies the callee.
  return client.send();
}

export async function callsDynamicImport(specifier: string): Promise<unknown> {
  return await import(specifier);
}

export function callsEval(source: string): unknown {
  // biome-ignore lint/security/noGlobalEval: the fixture exists to be unanalyzable
  return eval(source);
}

export function callsNewFunction(body: string): unknown {
  const built = new Function(body);
  return built();
}

export declare function bodyless(value: string): string;

export function callsBodylessDeclaration(): string {
  // §4.1 "Overloads and bodyless declarations": nothing to propagate from.
  return bodyless("a");
}

export function callsThroughUnknownReceiver(handlers: { run: () => void }): void {
  // No single object literal is certainly behind `handlers` (§4.2 rule 7):
  // `unresolved-symbol`.
  handlers.run();
}

/**
 * Inherits `unknown` from a callee and holds no unresolvable call of its own.
 * `AMB-I002` must stay off it — the work is at the leaf, which reports it.
 */
export function inheritsUnknown(source: string): unknown {
  return callsEval(source);
}

/**
 * Already declared, so neither diagnostic applies — an `unknown` inside a
 * declared function is that function's own AMB-W001, not an init proposal.
 * @effects pure
 */
export function declaredDespiteUnknown(source: string): unknown {
  // biome-ignore lint/security/noGlobalEval: the fixture exists to be unanalyzable
  return eval(source);
}

/**
 * Explicitly isolated. §4.6 excludes the body from analysis, so there is no
 * unresolved call to report and nothing to propose.
 * @effects fs_read
 * @boundary reason="legacy-store"
 */
export function isolated(key: string): string {
  return readLegacy(key);
}
