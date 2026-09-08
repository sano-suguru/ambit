// Every function-like node in this file is deliberately unindexed by
// `collectFunctionLikeDeclarations` (its documented slice boundary) — used
// to verify `collectSkippedFunctionKinds`' classification.

export class WithAccessors {
  get value(): number {
    return 1;
  }
  set value(_v: number) {}
}

export const withMethod = {
  method(): number {
    return 1;
  },
};

export default function (): number {
  return 1;
}

export function callsWithCallback(): number {
  return [1, 2, 3].map((n) => n * 2)[0] ?? 0;
}

export function hasNestedFunction(): number {
  function nested(): number {
    return 1;
  }
  return nested();
}
