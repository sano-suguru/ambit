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
/** @effects pure */
export function carriesItsOwn(): number {
  return 1;
}
