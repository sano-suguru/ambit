import { applyTax } from "./tax.ts";

/** @effects pure */
export function priceOrder(subtotal: number, region: string): number {
  return applyTax(subtotal, region);
}
