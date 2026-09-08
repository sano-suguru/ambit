/** @effects pure */
export function pureCallsFetchDirectly(): void {
  fetch("https://example.com");
}

/** @effects pure */
export async function pureAsyncCallsFetchDirectly(): Promise<void> {
  // await is transparent (DESIGN.md §4.2 rule 5): this must be detected
  // exactly like the synchronous case above.
  await fetch("https://example.com");
}
