import { createStore } from "widget-store";

// A `let` may hold a different object by the time the call runs, so the
// binding fixes nothing and the receiver keeps no name.
let store = createStore();

export function reassignStore(): void {
  store = createStore();
}

export function readsThroughMutableBinding(): string | undefined {
  return store.get("k");
}
