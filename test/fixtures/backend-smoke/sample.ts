/** @effects network */
export async function fetchRateDeclared(): Promise<number> {
  const res = await fetch("https://example.com/rate");
  return Number(await res.text());
}

export async function fetchRateUndeclared(): Promise<number> {
  const res = await fetch("https://example.com/rate");
  return Number(await res.text());
}

/** @effects pure */
export function calculateTax(amount: number): number {
  return amount * 0.1;
}

/** @effects pure */
export function calculateTaxViaDeclaredCallee(amount: number): number {
  return amount * (1 + rateFromDeclared());
}

function rateFromDeclared(): number {
  return 0.1;
}

export function callsDynamicImport(): void {
  void import("node:fs");
}

export function callsEval(): void {
  // biome-ignore lint/security/noGlobalEval: fixture data for the "eval" detection rule, never executed
  eval("1 + 1");
}

export function callsUnknownCallback(cb: () => void): void {
  cb();
}
