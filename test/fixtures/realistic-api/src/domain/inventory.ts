import type { OrderLine } from "./model.ts";

export interface StockLevel {
  readonly sku: string;
  readonly onHand: number;
  readonly reserved: number;
}

/** @effects pure */
export function available(level: StockLevel): number {
  return Math.max(0, level.onHand - level.reserved);
}

/** @effects pure */
export function isBackordered(level: StockLevel): boolean {
  return available(level) === 0;
}

/** @effects pure */
export function reserveFor(level: StockLevel, quantity: number): StockLevel {
  return { sku: level.sku, onHand: level.onHand, reserved: level.reserved + quantity };
}

/** @effects pure */
export function totalOnHand(levels: readonly StockLevel[]): number {
  let total = 0;
  for (const level of levels) total += level.onHand;
  return total;
}

/** @effects pure */
export function backorderedSkus(levels: readonly StockLevel[]): readonly string[] {
  return levels.filter(isBackordered).map((level) => level.sku);
}

/** @effects pure */
export function canFulfill(levels: readonly StockLevel[], lines: readonly OrderLine[]): boolean {
  return lines.every((line) => {
    const level = levels.find((candidate) => candidate.sku === line.sku);
    return level !== undefined && available(level) >= line.quantity;
  });
}

/** @effects pure */
export function shortfall(level: StockLevel, wanted: number): number {
  return Math.max(0, wanted - available(level));
}

/**
 * A class with an accessor. The getter's body is analyzed and propagates like
 * any method's, but a contract *comment* on it is inert (DESIGN.md §4.1 (a)):
 * `ambit.config.ts` is the only place its contract can be written, which is
 * what `ambit init --config` proposes and what the round-trip test applies.
 */
export class StockSummary {
  readonly levels: readonly StockLevel[];

  constructor(levels: readonly StockLevel[]) {
    this.levels = levels;
  }

  get shortfall(): number {
    return this.levels.filter((level) => isBackordered(level)).length;
  }
}
