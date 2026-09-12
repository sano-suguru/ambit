// Calling a method on a receiver bound by `const` to one `new` (DESIGN.md
// §4.2 rule 7, the same premise as the object-literal receiver: `const` fixes
// the binding, not the object). The `extends` chain is walked because an
// inherited method is the one that runs — and walked derived-first, because an
// override is the implementation reached at runtime.

interface Runner {
  run(): number;
  idle(): number;
}

export class Engine implements Runner {
  /** @effects pure */
  run(): number {
    return 1;
  }

  /** @effects network */
  idle(): number {
    return 0;
  }
}

// Both classes declare `run`. The derived one is what runs.
export class Tuned extends Engine {
  /** @effects fs_read */
  run(): number {
    return 2;
  }
}

// -- resolves --------------------------------------------------------------

// The annotation says `Runner`, which declares a signature and no body. The
// value says `Engine`, which has one.
const annotated: Runner = new Engine();

export function callsAnnotated(): number {
  return annotated.run();
}

// Annotated, so the checker answers with `Runner`'s signature and the walk is
// what decides. Both classes declare `run`; walking base-first would answer
// `Engine.run`, which is not the implementation that runs.
const overriding: Runner = new Tuned();

export function callsOverride(): number {
  return overriding.run();
}

// The other direction on the same chain: only `Engine` declares `idle`, so the
// walk has to reach the base to find it at all.
export function callsInherited(): number {
  return overriding.idle();
}

// -- must not resolve ------------------------------------------------------

// A reassignable receiver is not a fact about the call: `let` may hold a
// different `Runner` by the time it runs. The annotation is what makes this a
// test of the rule at all — without it the checker answers with `Engine.run`
// itself and the receiver is never consulted, `const` or not.
// biome-ignore lint/style/useConst: `let` is the point of this fixture
export let mutable: Runner = new Engine();

export function callsMutable(): number {
  return mutable.run();
}

// An ambient class has no member this project indexed, so the walk reaches it
// and finds nothing. The call is a builtin method, not a resolved target.
const builtin = new Set<number>();

export function callsBuiltinInstance(): number {
  builtin.add(1);
  return builtin.size;
}

// A class *expression* bound to a `const`: whatever the adopted backend does
// here is the requirement, and the assertion records it rather than assuming.
const Anonymous = class {
  run(): number {
    return 3;
  }
};
const fromClassExpression = new Anonymous();

export function callsClassExpression(): number {
  return fromClassExpression.run();
}
