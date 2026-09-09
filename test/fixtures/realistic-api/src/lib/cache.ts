const rateCache = new Map<string, number>();

/** @effects pure */
export function cachedRate(currency: string): number | undefined {
  return rateCache.get(currency);
}

export function putRate(currency: string, rate: number): void {
  rateCache.set(currency, rate);
}
