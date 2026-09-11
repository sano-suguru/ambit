/**
 * A stand-in package whose clients are handed out by factories rather than by
 * a constructor — the shape `mysql2/promise` has, and the one the receiver
 * naming rule under test has to reach.
 *
 * Declared here rather than installed so the fixture type-checks with nothing
 * in `node_modules`: the rule keys on what the project's own source says, so a
 * hand-written `declare module` and an installed package give the same answer.
 */
declare module "widget-store" {
  export interface Store {
    get(key: string): string | undefined;
    put(key: string, value: string): void;
  }

  export interface Handle {
    close(): void;
  }

  /** The factory shape under test: a plain call returning a named type. */
  export function createStore(): Store;

  /** The `await`ed variant — `mysql2/promise`'s `createConnection` shape. */
  export function openHandle(): Promise<Handle>;

  /**
   * Returns a type the compiler's own lib declares. Naming its result
   * `widget-store.Map` would take `map.get(...)` away from the pure-builtin
   * allowlist, which is the one regression this rule must not cause.
   */
  export function createIndex(): Map<string, number>;

  /** An anonymous return type has no name to key on. */
  export function createAnonymous(): { run(): void };

  /** The default export, for `import widgets from "widget-store"`. */
  const widgets: {
    createStore(): Store;
  };
  export default widgets;
}

declare module "widget-store/sub" {
  export interface Store {
    get(key: string): string | undefined;
  }
  export function createStore(): Store;
}
