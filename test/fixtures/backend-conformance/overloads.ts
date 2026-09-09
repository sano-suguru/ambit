// An overloaded function: the call resolves to one of the signatures, but only
// the implementation has a body, and only the body carries effects. A backend
// that stops at the matched signature reaches a declaration with no body.

/** @effects pure */
export function widen(value: string): string;
/** @effects pure */
export function widen(value: number): number;
export function widen(value: string | number): string | number {
  return value;
}

export function callsOverloadFirst(): string {
  return widen("a");
}

export function callsOverloadSecond(): number {
  return widen(1);
}

// An overload set with no implementation in this file at all (ambient), so
// there is no body to reach.
export declare function ambientOverload(value: string): string;
export declare function ambientOverload(value: number): number;

export function callsAmbientOverload(): string {
  return ambientOverload("a");
}

// The implementation is where the effects are. A caller that reaches only the
// first *signature* sees a declaration with no body — and a body-less
// declaration has no observed effects, which reads as `pure`.
export function loadOverloaded(key: string): Promise<string>;
export function loadOverloaded(key: number): Promise<string>;
export async function loadOverloaded(key: string | number): Promise<string> {
  const res = await fetch(`https://example.com/${String(key)}`);
  return res.text();
}

/** @effects pure */
export function claimsPureThroughOverload(): Promise<string> {
  return loadOverloaded("a");
}

/** @effects pure */
export function claimsPureThroughAmbientOverload(): string {
  return ambientOverload("a");
}

// The same rule on a class. A method's overload signatures and an `abstract`
// member are bodyless declarations too, and they reach the extraction through
// a different branch than a free function does — so they are here rather than
// assumed to follow.
export class Store {
  save(value: string): void;
  save(value: number): void;
  save(value: string | number): void {
    void fetch(`https://example.com/${String(value)}`);
  }
}

const store = new Store();

export function callsOverloadedMethod(): void {
  store.save("a");
}

export abstract class Repo {
  abstract load(id: string): string;
}
