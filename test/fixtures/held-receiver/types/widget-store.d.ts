/**
 * A stand-in package whose client is *handed to* the code that uses it — the
 * shape every dependency-injected server has, and the one the receiver naming
 * rule under test has to reach. Its fluent builder stands in for a query
 * builder (`knex`), where the receiver of the interesting call is the result
 * of an earlier call rather than any binding at all.
 *
 * Declared here rather than installed so the fixture type-checks with nothing
 * in `node_modules`: a `declare module` names its own module, so a
 * hand-written declaration and an installed package give the same key.
 */
declare module "widget-store" {
  export class Client {
    read(key: string): string | undefined;
    table(name: string): Query;
  }

  export interface Query {
    where(key: string): Query;
    del(): Promise<void>;
  }

  /** Reached through a property on the client, the way a Prisma delegate is. */
  export interface Delegate {
    findMany(): Promise<string[]>;
  }

  export interface Hub {
    users: Delegate;
    /**
     * Returns a type the compiler's own lib declares. Naming its result
     * `widget-store.Map` would take `entries().get(...)` off the pure-builtin
     * allowlist, which is the one regression this rule must not cause.
     */
    entries(): Map<string, number>;
  }
}
