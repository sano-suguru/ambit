// Call *targets*: which callee declarations the backend can reach, and
// therefore which calls carry a `resolvedCallee`.
//
// The object-literal forms are reached by following the receiver's *value*,
// not its static type — so a type annotation on the literal does not change
// the outcome. The two parameter-typed callers at the bottom are the contrast:
// their receiver has no single object literal behind it, so they stay
// unresolved.

export function indexedTarget(): number {
  return 1;
}

interface Dispatcher {
  run(): number;
}

type DispatcherAlias = {
  run(): number;
};

// A module-scope variable-bound arrow. Indexed as `call-resolution.ts#boundArrow`
// — kept here because nothing else in the fixtures has this shape, and it is
// the one that used to be counted as both extracted and skipped.
export const boundArrow = (): number => 1;

export const literalWithNamedFunction = {
  run: indexedTarget,
};

// The shape Ambit's own `legacyTsBackend` uses: a shorthand property naming an
// already-indexed function, on a literal annotated with an interface. The
// checker resolves `.indexedTarget` to `Backend`'s member signature, not to
// the literal, so only following the receiver's value reaches the function.
interface Backend {
  indexedTarget(): number;
}

export const literalWithShorthand: Backend = {
  indexedTarget,
};

export const literalWithShorthandMethod = {
  run(): number {
    return 1;
  },
};

export const literalWithArrow = {
  run: (): number => 1,
};

export const literalTypedByInterface: Dispatcher = {
  run: indexedTarget,
};

export const literalSatisfies = {
  run: (): number => 1,
} satisfies Dispatcher;

// A member whose body lives in the literal carries its own contract
// (DESIGN.md §4.1: `@effects` の付与先 = 任意の関数・メソッド).
export const literalWithDeclaredMethod = {
  /** @effects fs_read */
  read(): number {
    return 1;
  },
};

// A reassignable receiver is not a fact about the call: `let` may hold a
// different object by the time the call runs.
// biome-ignore lint/style/useConst: `let` is the point of this fixture
export let mutableLiteral = { run: indexedTarget };

// A spread can carry members this walk cannot enumerate, so a syntactic match
// on the members written here is not trustworthy. The guard rejects any
// spread, not only one that demonstrably overrides.
const extraMembers = { other: (): number => 9 };
export const spreadLiteral = { run: indexedTarget, ...extraMembers };

export class IndexedClass {
  method(): number {
    return 1;
  }
}

const classInstance = new IndexedClass();

export function callsBoundArrow(): number {
  return boundArrow();
}

export function callsLiteralWithNamedFunction(): number {
  return literalWithNamedFunction.run();
}

export function callsLiteralWithShorthand(): number {
  return literalWithShorthand.indexedTarget();
}

export function callsLiteralWithShorthandMethod(): number {
  return literalWithShorthandMethod.run();
}

export function callsLiteralWithArrow(): number {
  return literalWithArrow.run();
}

export function callsLiteralTypedByInterface(): number {
  return literalTypedByInterface.run();
}

export function callsLiteralSatisfies(): number {
  return literalSatisfies.run();
}

export function callsClassInstanceMethod(): number {
  return classInstance.method();
}

export function callsLiteralDeclaredMethod(): number {
  return literalWithDeclaredMethod.read();
}

// Not resolvable: the receiver is a parameter, so no single object literal
// stands behind it.
export function callsInterfaceParam(d: Dispatcher): number {
  return d.run();
}

export function callsMutableLiteral(): number {
  return mutableLiteral.run();
}

export function callsSpreadLiteral(): number {
  return spreadLiteral.run();
}

export function callsTypeAliasParam(d: DispatcherAlias): number {
  return d.run();
}
