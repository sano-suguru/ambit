// No @effects tag: this function is undeclared, not "pure".
export function fetchRateUndeclared(): number {
  fetch("https://example.com/rate");
  return 0;
}

/** @effects pure */
export function calculateTaxUndeclaredCallee(amount: number): number {
  return amount * (1 + fetchRateUndeclared());
}
