import { createStore } from "widget-store";

const store = createStore();

export function readsThroughNamedImportFactory(): string | undefined {
  return store.get("k");
}
