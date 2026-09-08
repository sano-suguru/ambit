// Contract tags written on function-like nodes the backend does not extract.
// Each one looks like a guarantee and provides none, so each must be reported
// (AMB-E003) rather than silently dropped.

export class WithAccessor {
  /** @effects fs_read */
  get value(): number {
    return 1;
  }
}

export const nonIdentifierKey = {
  /** @effects network */
  "a-b"(): number {
    return 1;
  },
};

/** @effects db_write */
export default function (): number {
  return 1;
}

// An extracted function declaring a contract, so the fixture also proves
// AMB-E003 does not fire on a node that *can* carry one.
//
// The inline callback matters: it is a skipped node sitting inside a declared
// function, so if `ts.getJSDocTags` ever walked up from it to the enclosing
// JSDoc, every declared function containing a lambda would be reported. The
// count assertion in the test pins that it does not.
/** @effects pure */
export function carriesItsOwn(values: readonly number[]): number {
  return values.map((v) => v)[0] ?? 1;
}
