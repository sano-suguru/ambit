// §3.5 gate 1, §4.2 rule 4: a callback slot declared *optional* —
// `cb?: (v: T) => R`, which `Promise.then`, `Array.map` and most callback APIs
// use — gives both the declared parameter and the argument the union type
// `((v: T) => R) | null | undefined`. A union has no call signatures of its
// own however callable its constituents are, so a backend that asks the union
// directly reports the reference as "not callable", never scans it, and lets
// an opaque callback past the opacity guard.

// Both arguments are opaque parameters handed to a higher-order builtin. The
// guard has to see them: neither can be walked, so `Promise.then` cannot be
// trusted as pure here.
export function forwardsOptionalCallbacks<T>(
  promise: Promise<T>,
  onFulfilled?: ((value: T) => T) | null,
  onRejected?: ((reason: unknown) => T) | null,
): Promise<T> {
  return promise.then(onFulfilled, onRejected);
}

// A `null` literal in a callback slot is not callable and must not be counted:
// nothing is passed, so nothing is opaque.
export function passesNoCallback<T>(promise: Promise<T>): Promise<T> {
  return promise.then(null, undefined);
}

function double(value: number): number {
  return value * 2;
}

// An optional callback slot handed a reference this project *did* extract:
// the reference is followed, so the site is a target rather than opacity.
export function passesExtractedCallback(promise: Promise<number>): Promise<number> {
  return promise.then(double);
}

// The other half of the same narrowing, and the half that a backend unable to
// read the *declared* parameter list loses silently rather than loudly.
// `Object.keys` declares `o: {}` and `new Proxy` declares
// `handler: ProxyHandler<T>`; neither position is a callback slot, so an
// argument that merely *could* be callable — `any` is callable as far as the
// argument test is concerned — must not make the call read as opaque. A
// backend that sees no parameters there falls open at every index and reports
// `callbackByReference` on both of these. Measured on `drizzle-orm`, eleven of
// fifteen divergences (`docs/measurements/2026-09-12-callable-slot-handle.md`).

// biome-ignore lint/suspicious/noExplicitAny: an any-typed argument is the point
export function passesAnyToNonCallbackSlot(value: any): string[] {
  return Object.keys(value);
}

// biome-ignore lint/suspicious/noExplicitAny: an any-typed argument is the point
export function passesAnyToNonCallbackConstructorSlot(target: object, handler: any): object {
  return new Proxy(target, handler);
}

// A union whose one callable constituent sits in a non-callback slot. The
// argument test says "may be callable" and is right to; the slot says this was
// never a callback, and that is what decides. `Boolean(value?: T)` is the
// shape `drizzle-orm` hit twice.
export function passesCallableUnionToNonCallbackSlot(
  value: string | ((x: number) => number) | undefined,
): boolean {
  return Boolean(value);
}
