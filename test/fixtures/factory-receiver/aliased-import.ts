import { createStore as make } from "widget-store";

const store = make();

export function readsThroughAliasedFactory(): string | undefined {
  return store.get("k");
}
