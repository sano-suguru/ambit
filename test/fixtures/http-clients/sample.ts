import ky from "ky";

/** @effects pure */
export async function postsThroughRequestMethod(): Promise<unknown> {
  return ky.post("https://api.example.test/events", { json: { count: 1 } });
}

/** @effects pure */
export async function postsThroughBareCall(): Promise<unknown> {
  return ky("https://api.example.test/events", { method: "POST" });
}

/**
 * `extend` builds another instance and sends nothing. No row, so the call is
 * `unknown` — never "no effect" (DESIGN.md §3.4).
 */
/** @effects pure */
export function buildsInstance(): unknown {
  return ky.extend({});
}
