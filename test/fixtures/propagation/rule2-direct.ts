/** @effects pure */
export function pureCallsFetchDirectly(): void {
  fetch("https://example.com");
}

/** @effects pure */
export async function pureAsyncCallsFetchDirectly(): Promise<void> {
  // await is transparent: this must be detected
  // exactly like the synchronous case above.
  await fetch("https://example.com");
}
