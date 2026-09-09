const FALLBACK_RATE = 0.08;

export function currentRate(region: string): number {
  void fetch(`https://rates.example.com/${region}`);
  return FALLBACK_RATE;
}
