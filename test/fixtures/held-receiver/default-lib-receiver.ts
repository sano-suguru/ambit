import type { Hub } from "widget-store";

export function readsDefaultLibResult(hub: Hub): number | undefined {
  return hub.entries().get("k");
}
