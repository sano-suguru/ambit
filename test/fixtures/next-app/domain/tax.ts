import type { OrderLine } from "./model.ts";

/**
 * @effects pure
 */
export function subtotal(lines: readonly OrderLine[]): number {
  let total = 0;
  for (const line of lines) total += line.quantity * line.unitCents;
  return total;
}

/**
 * @effects pure
 */
export function taxFor(cents: number, percent: number): number {
  return Math.round((cents * percent) / 100);
}
