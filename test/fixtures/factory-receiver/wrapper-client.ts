import { openStore } from "./project-wrapper.ts";

const store = openStore();

export function readsThroughProjectWrapper(): string | undefined {
  return store.get("k");
}
