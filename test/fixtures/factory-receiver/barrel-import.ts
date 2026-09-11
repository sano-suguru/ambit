import { createStore } from "./barrel.ts";

const store = createStore();

export function readsThroughBarrelFactory(): string | undefined {
  return store.get("k");
}
