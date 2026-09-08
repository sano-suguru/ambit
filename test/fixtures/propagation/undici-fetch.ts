import { fetch } from "undici";

// Regression fixture for the #11 named-import qualification: once the alias
// resolves (see undici.d.ts), `undici.fetch` must still be recognized as
// `network` via the stub table — not silently fall to `unknown`.
/** @effects pure */
export function pureCallsUndiciFetch(): void {
  fetch("https://example.com");
}
