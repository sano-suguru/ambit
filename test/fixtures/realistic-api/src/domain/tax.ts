import type { OrderLine } from "./model.ts";

/** @effects pure */
export function lineTotal(line: OrderLine): number {
  return line.unitCents * line.quantity;
}

/** @effects pure */
export function subtotal(lines: readonly OrderLine[]): number {
  let total = 0;
  for (const line of lines) total += lineTotal(line);
  return total;
}

/** @effects pure */
export function taxFor(subtotalCents: number, ratePercent: number): number {
  return Math.round((subtotalCents * ratePercent) / 100);
}

/** Subtotal plus tax, in cents. */
export function totalWithTax(lines: readonly OrderLine[], ratePercent: number): number {
  const base = subtotal(lines);
  return base + taxFor(base, ratePercent);
}
