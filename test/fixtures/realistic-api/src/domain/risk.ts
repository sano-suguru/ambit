import type { CreateOrderInput, OrderLine } from "./model.ts";

/** Risk scoring, all of it decided from the order in hand. */

/** @effects pure */
export function lineRisk(line: OrderLine): number {
  return line.unitCents > 100_000 ? 2 : line.quantity > 50 ? 1 : 0;
}

/** @effects pure */
export function orderRisk(input: CreateOrderInput): number {
  let score = 0;
  for (const line of input.lines) score += lineRisk(line);
  return score;
}

/** @effects pure */
export function riskLabel(score: number): string {
  return score >= 4 ? "high" : score >= 2 ? "medium" : "low";
}

/** @effects pure */
export function needsReview(input: CreateOrderInput): boolean {
  return riskLabel(orderRisk(input)) !== "low";
}

/** @effects pure */
export function distinctSkus(lines: readonly OrderLine[]): readonly string[] {
  const seen = new Set<string>();
  for (const line of lines) seen.add(line.sku);
  return [...seen];
}

/** @effects pure */
export function largestLine(lines: readonly OrderLine[]): OrderLine | undefined {
  let largest: OrderLine | undefined;
  for (const line of lines) {
    if (!largest || line.unitCents * line.quantity > largest.unitCents * largest.quantity) {
      largest = line;
    }
  }
  return largest;
}
