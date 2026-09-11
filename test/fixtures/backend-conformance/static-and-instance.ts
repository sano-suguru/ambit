// A class that declares an instance member and a static member of the same
// name. Both have bodies, both run, and they are two different functions — so
// two declaration paths, per DESIGN.md §4.1 (a). One shared path is not a
// wrong answer but no answer: `propagate` would hold two summaries under one
// id and never reach a fixed point.
//
// The effects differ deliberately. Two entries under one id only fail to
// converge when their summaries disagree, so a fixture where both are `pure`
// would pass while the defect was present.

export class Cache {
  /** @effects network */
  public load(key: string): Promise<Response> {
    return fetch(`https://example.com/${key}`);
  }

  /** @effects pure */
  public static load(key: string): string {
    return key;
  }

  public get size(): number {
    return 0;
  }

  public static get size(): number {
    return 0;
  }
}

export function callsInstanceLoad(cache: Cache): Promise<Response> {
  return cache.load("a");
}

export function callsStaticLoad(): string {
  return Cache.load("a");
}

// A namespace member and a top-level function of the same name. The namespace
// is a named container, so its member's declaration path hangs off that name
// (`sql.param`) the way a class member's hangs off the class. Descending into
// the namespace with the path unchanged gives both functions one id.
// Observed in `drizzle-orm`'s `src/sql/sql.ts`, which declares exactly this.

/** @effects network */
export function param(value: string): Promise<Response> {
  return fetch(`https://example.com/${value}`);
}

export namespace sql {
  /** @effects pure */
  export function param(value: string): string {
    return value;
  }
}

export function callsTopLevelParam(): Promise<Response> {
  return param("a");
}

export function callsNamespacedParam(): string {
  return sql.param("a");
}
