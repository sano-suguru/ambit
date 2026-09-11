/** Declared by this project, not by a package: §4.2 rule 7 still decides it. */
export interface Store {
  read(key: string): string | undefined;
}

export function readsThroughProjectInterface(store: Store): string | undefined {
  return store.read("k");
}
