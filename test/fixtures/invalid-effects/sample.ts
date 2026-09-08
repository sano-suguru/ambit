// A typo'd @effects tag must be rejected (AMB-E002), not silently narrowed
// to an empty (pure) contract that would then also trip AMB-E001.

/** @effects netwrok */
export function declaresTypoedEffect(): void {
  fetch("https://example.com");
}

/** @effects network */
export function declaresValidEffect(): void {
  fetch("https://example.com");
}
