// Calling through a receiver bound by `const` to one object literal
// (DESIGN.md §4.2 rule 7). The member is found in the literal itself, so a
// type annotation on the receiver — which makes the checker return the
// annotation's member signature instead of the literal's own member — does not
// hide the target. This is the shape of Ambit's own
// `legacyTsBackend: TsBackend = { extractProject }`, and the negatives below
// are the boundary: each one is a receiver a broader rule would resolve and a
// correct one must not, because no single literal is certainly behind it.

/** @effects pure */
export function target(): number {
  return 1;
}

interface Dispatcher {
  run(): number;
}

// -- resolves --------------------------------------------------------------

// The annotation wins in the type system and loses here: the value is one
// literal, and the value is what runs.
export const annotated: Dispatcher = {
  run: target,
};

export function callsAnnotated(): number {
  return annotated.run();
}

// `as const` asserts a type without changing which object the member belongs
// to, so it is unwrapped rather than rejected — the same as `satisfies`.
export const asConst = {
  run: target,
} as const;

export function callsAsConst(): number {
  return asConst.run();
}

// -- must not resolve ------------------------------------------------------

const rebound = target;

// One hop, and one only: the member holds a binding that holds the function.
// Following further is another place the analysis could be wrong without
// saying so, and no shape this rule exists for needs it.
export const literalWithRebind = {
  run: rebound,
};

export function callsRebind(): number {
  return literalWithRebind.run();
}

function makeTarget(): () => number {
  return target;
}

// The member's value is a call result, not a named function: which function
// comes back is not decided here.
export const literalWithCallResult = {
  run: makeTarget(),
};

export function callsCallResult(): number {
  return literalWithCallResult.run();
}

// A member written as a property whose value is another member of the same
// literal is not a named declaration this rule reaches either.
export const literalWithIndexedAccess = {
  run: { inner: target }.inner,
};

export function callsIndexedAccess(): number {
  return literalWithIndexedAccess.run();
}
