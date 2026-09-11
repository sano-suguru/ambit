import type { Client } from "widget-store";

export function readsThroughParameter(client: Client): string | undefined {
  return client.read("k");
}
