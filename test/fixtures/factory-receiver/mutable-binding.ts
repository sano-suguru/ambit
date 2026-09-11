import { createStore } from "widget-store";

// A `let` may hold a different object by the time the call runs, so the
// binding fixes nothing and none of the origin rules names it. Its declared
// type still does: whatever it holds is a `Store` this package declares.
let store = createStore();

export function reassignStore(): void {
  store = createStore();
}

export function readsThroughMutableBinding(): string | undefined {
  return store.get("k");
}
