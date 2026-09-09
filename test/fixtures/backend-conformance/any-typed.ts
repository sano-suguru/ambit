// `any` is where analysis stops. §4.2 rule 6 requires `unknown`, not a pure
// verdict, and §4.7 forbids treating `as any` and `!` alike: a non-null
// assertion keeps the declaration, an `any` cast destroys it.

/** @effects pure */
export function pureTarget(): number {
  return 1;
}

// biome-ignore lint/suspicious/noExplicitAny: an any-typed callee is the point
const anyTarget: any = pureTarget;

export function callsAnyTyped(): number {
  return anyTarget();
}

// biome-ignore lint/suspicious/noExplicitAny: an any-typed receiver is the point
const anyReceiver: any = { run: pureTarget };

export function callsAnyTypedMember(): number {
  return anyReceiver.run();
}

// A non-null assertion keeps the declaration: this must NOT become `any-typed`.
export function callsNonNullAsserted(f?: () => number): number {
  return f!();
}

export function callsThroughAnyCast(): number {
  // biome-ignore lint/suspicious/noExplicitAny: the cast is the point
  return (pureTarget as any)();
}
