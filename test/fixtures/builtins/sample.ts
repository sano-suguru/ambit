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
  // biome-ignore lint/suspicious/noGlobalIsNan: the global is the subject — it is what the bare-identifier table is keyed on
  const nan = isNaN(Number(raw));
  return Number(raw) + parseInt(raw, 10) + (nan ? 0 : 1);
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

export function mapsAReferencedProjectFunction(values: readonly string[]): readonly string[] {
  // The callback is passed by reference and names a function in this tree, so
  // it is the answer to what the callback does (DESIGN.md §4.2 rule 4) — the
  // call carries an edge to `upper` rather than falling to `unknown`.
  return values.map(upper);
}

function upper(value: string): string {
  return value.toUpperCase();
}

export function mapsAReferencedEffectfulFunction(values: readonly string[]): readonly string[] {
  // Same shape, and still not "no effect": the referenced function's own body
  // is what propagates.
  return values.map(logAndReturn);
}

function logAndReturn(value: string): string {
  console.log(value);
  return value;
}

export function mapsAnOpaqueCallback(
  values: readonly string[],
  transform: (value: string) => string,
): readonly string[] {
  // A parameter names no declaration this tree extracted, so the rule's other
  // half applies: if it cannot be inferred, `unknown`.
  return values.map(transform);
}

export function inspectsAFunctionValue(): boolean {
  // `Array.isArray` cannot call what it is handed, so a callable argument
  // does not cost the call its verdict.
  return Array.isArray(upper);
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
