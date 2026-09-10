// Default-lib calls, in pairs: one the stub tables answer, and one beside it
// that must stay `unknown` or must carry an effect. The pairing is the point —
// a table that answered both would be claiming more than it can see.

export function readsObjectAndString(input: Record<string, string>): string {
  const pairs = Object.entries(input);
  const keys = Object.keys(input);
  return pairs
    .map(([key, value]) => `${key}=${value.replace(/\s+/g, "-")}`)
    .join(",")
    .concat(String(keys.length));
}

export function convertsWithGlobals(raw: string): number {
  return Number(raw) + parseInt(raw, 10) + (isNaN(Number(raw)) ? 0 : 1);
}

export function readsADateInstance(at: Date): string {
  return at.toISOString().slice(0, 10);
}

export function readsAHeaderAndDecodes(headers: Headers, bytes: Uint8Array): string {
  return `${headers.get("x-request-id") ?? ""}${new TextDecoder().decode(bytes)}`;
}

// -- the nearby cases that must not become "no effect" --------------------

export function assignsOntoAnArgument(target: Record<string, string>): Record<string, string> {
  // `Object.assign` mutates its first argument, not its receiver, so the
  // locality rule cannot answer for it and neither table lists it.
  return Object.assign(target, { seen: "1" });
}

export function readsAResponseBody(response: Response): Promise<unknown> {
  // What a `Response` body is backed by is not visible here.
  return response.json();
}

export function logs(message: string): void {
  console.log(message);
}

export function compilesAString(source: string): unknown {
  // DESIGN.md §4.2 rule 6.
  return Function(source);
}

export function mapsByReference(values: readonly string[]): readonly string[] {
  // The callback is passed by reference, so `Array.map` being allowlisted
  // says nothing about what runs (DESIGN.md §4.2 rule 4).
  return values.map(logAndReturn);
}

function logAndReturn(value: string): string {
  console.log(value);
  return value;
}

// -- effects, not the absence of one --------------------------------------

/** @effects pure */
export function readsTheClock(): number {
  return Date.now();
}

/** @effects pure */
export function rolls(): number {
  return Math.random();
}

// -- mutation through a receiver ------------------------------------------

/** @effects pure */
export function writesAnArgumentsHeaders(headers: Headers): void {
  headers.set("x-seen", "1");
}

export function writesItsOwnHeaders(): Headers {
  const headers = new Headers();
  headers.set("x-seen", "1");
  headers.append("x-seen", "2");
  return headers;
}
