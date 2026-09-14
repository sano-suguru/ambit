// Named imports whose module does not resolve, spelled with names the bundled
// tables key on as globals. Nothing establishes that these bindings are the
// global `fetch` or `URL` — the specifier is deliberately one no install can
// satisfy, so the fixture does not depend on what `node_modules` holds.
import { fetch, URL } from "./no-such-http-client.ts";

/** @effects pure */
export function pureCallsUnresolvedFetch(url: string): unknown {
  return fetch(url);
}

/** @effects pure */
export function pureConstructsUnresolvedUrl(href: string): unknown {
  return new URL(href);
}
