// The function-like nodes here are the ones `collectFunctionLikeDeclarations`
// treats specially — used to verify both `collectSkippedFunctionKinds`'
// classification and the two shapes only `ambit.config.ts` can declare
// (DESIGN.md §4.1 (a)).

export class WithAccessors {
  // Extracted as `WithAccessors.get value`, but the contract comment on it is
  // still inert: §4.1 (a) does not open JSDoc for accessors, so this is
  // AMB-E003 with the config key that would work.
  /** @effects fs_read */
  get value(): number {
    return 1;
  }
  set value(_v: number) {}
}

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
