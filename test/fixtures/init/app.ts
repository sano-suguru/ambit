// Fixture for `ambit init` (DESIGN.md §4.1): infer effects for undeclared
// functions and propose the JSDoc as an applicable patch. The point of the
// round-trip test is that applying every proposal leaves `ambit check` clean —
// an inferred contract Ambit would then reject is worse than no proposal.

import { readFileSync } from "node:fs";

export function addTax(amount: number, rate: number): number {
  return amount * (1 + rate);
}

export function loadConfig(path: string): string {
  return readFileSync(path, "utf8");
}

export async function fetchRate(): Promise<number> {
  const response = await fetch("https://rates.example.test");
  return response.status;
}

/** Effects reach here through a call, not directly. */
export async function pricedTotal(amount: number): Promise<number> {
  return addTax(amount, await fetchRate());
}

/** An existing JSDoc block with no contract tag: the tag is added to it, not stacked above. */
export function documentedButUndeclared(a: number): number {
  return addTax(a, 0);
}

/**
 * Its effects cannot be resolved, so `init` must propose nothing. Declaring
 * it pure here would turn "could not tell" into a guarantee.
 */
export function opaque(input: string): unknown {
  // biome-ignore lint/security/noGlobalEval: the fixture exists to be unanalyzable
  return eval(input);
}

/**
 * Already declared — nothing to propose.
 * @effects pure
 */
export function alreadyDeclared(a: number): number {
  return a;
}

/**
 * A class with no constructor written still runs its property initializers,
 * so the construction has effects — but there is no declaration site to put a
 * contract on. `init` must report that rather than propose an inert comment
 * above the class.
 */
export class Loader {
  readonly config = loadConfig("./config.json");
}
