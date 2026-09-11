import { sharedStore } from "./shared-client.ts";

export function readsThroughImportedClient(): string | undefined {
  return sharedStore.get("k");
}
