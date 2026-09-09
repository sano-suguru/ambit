// A union receiver: the property exists on both members, so the type checks,
// but the call has two possible declarations. Ambit must not pick one and
// report a single `resolvedCallee` as if the target were fixed.

/** @effects fs_read */
export function readsLeft(): number {
  return 1;
}

/** @effects network */
export function readsRight(): number {
  return 2;
}

const left = { run: readsLeft };
const right = { run: readsRight };

export function callsUnionMember(flag: boolean): number {
  const target: { run(): number } = flag ? left : right;
  return target.run();
}

type Shape = { kind: "a"; run(): number } | { kind: "b"; run(): number };

export function callsUnionParameter(s: Shape): number {
  return s.run();
}

// A union of a function type and undefined: the optional call is still a call.
export function callsOptionalUnion(f?: () => number): number {
  return f?.() ?? 0;
}
