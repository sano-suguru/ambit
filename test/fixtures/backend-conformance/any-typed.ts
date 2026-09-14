// `any` is where analysis stops. A call through `any` is `unknown`, not a pure
// verdict, and `as any` and `!` are not treated alike: a non-null
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
