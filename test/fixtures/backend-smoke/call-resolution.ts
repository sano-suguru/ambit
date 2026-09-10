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
// (DESIGN.md §4.1: `@effects` goes on any function or method).
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

// -- the same rule on a class instance ------------------------------------
// DESIGN.md §4.2 rule 7: "Method resolution on class instances rests on the
// same premise". The annotated and the bare binding must give one answer.

interface Runner {
  run(): number;
}

class Engine implements Runner {
  run(): number {
    return 1;
  }
}

class TunedEngine extends Engine {
  tune(): number {
    return 2;
  }
}

const bareEngine = new Engine();
const typedEngine: Runner = new Engine();
const derivedEngine = new TunedEngine();

export function callsBareInstance(): number {
  return bareEngine.run();
}

export function callsInstanceTypedByInterface(): number {
  return typedEngine.run();
}

// An inherited method is the one that runs, so the `extends` chain is walked.
export function callsInheritedInstanceMethod(): number {
  return derivedEngine.run();
}

// A parameter is any object satisfying the type.
export function callsRunnerParam(runner: Runner): number {
  return runner.run();
}

// A factory result is not a `new` this walk can see.
export function callsFactoryResult(): number {
  const made = makeEngine();
  return made.run();
}

function makeEngine(): Runner {
  return new Engine();
}
