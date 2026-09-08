// Call *targets*, not call sites: which callee declarations
// `collectFunctionLikeDeclarations` indexes, and therefore which calls can
// carry a `resolvedCallee`. The object-literal forms here are the contrast
// case — their callee declaration is never indexed, so the call falls through
// to the residual `unresolved-symbol`.

export function indexedTarget(): number {
  return 1;
}

interface Dispatcher {
  run(): number;
}

export const literalWithNamedFunction = {
  run: indexedTarget,
};

export const literalWithShorthandMethod = {
  run(): number {
    return 1;
  },
};

export const literalTypedByInterface: Dispatcher = {
  run: indexedTarget,
};

export class IndexedClass {
  method(): number {
    return 1;
  }
}

const classInstance = new IndexedClass();

export function callsLiteralWithNamedFunction(): number {
  return literalWithNamedFunction.run();
}

export function callsLiteralWithShorthandMethod(): number {
  return literalWithShorthandMethod.run();
}

export function callsLiteralTypedByInterface(): number {
  return literalTypedByInterface.run();
}

export function callsClassInstanceMethod(): number {
  return classInstance.method();
}
