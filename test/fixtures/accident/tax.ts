import { currentRate } from "./rates.ts";

export function applyTax(subtotal: number, region: string): number {
  return Math.round(subtotal * (1 + currentRate(region)));
}
