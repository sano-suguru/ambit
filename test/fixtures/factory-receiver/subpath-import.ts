import { createStore } from "widget-store/sub";

const store = createStore();

export function readsThroughSubpathFactory(): string | undefined {
  return store.get("k");
}
