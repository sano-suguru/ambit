// §3.5 gate 1: generic, overload, union, `any`, recursion, callback, and the
// position of a call site that follows non-ASCII text. Each shape is here
// because a backend can have the type information and still fail to fix the
// *call target*, which is what Ambit propagates from.

/** @effects pure */
export function identity<T>(value: T): T {
  return value;
}

// A generic callee reached through a type parameter: the declaration is fixed
// even though the type is not.
export function callsGeneric(): number {
  return identity<number>(1);
}

export function callsGenericInferred(): string {
  return identity("x");
}

/** @effects pure */
export function genericHigherOrder<T, U>(xs: readonly T[], f: (t: T) => U): U[] {
  return xs.map(f);
}

// A generic function passed a callback *by reference*: §4.2 rule 4 still
// applies, generic or not.
function toLength(s: string): number {
  return s.length;
}

export function callsGenericWithCallbackByReference(): number[] {
  return genericHigherOrder(["a", "bb"], toLength);
}
