/** Declared by this project, not by a package: its type still resolves nothing. */
export interface Store {
  read(key: string): string | undefined;
}

export function readsThroughProjectInterface(store: Store): string | undefined {
  return store.read("k");
}
