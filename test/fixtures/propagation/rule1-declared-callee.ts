/** @effects network */
export function fetchRateDeclared(): number {
  fetch("https://example.com/rate");
  return 0;
}

/** @effects pure */
export function calculateTaxDeclaredCallee(amount: number): number {
  return amount * (1 + fetchRateDeclared());
}
