import { createStore } from "widget-store";

// The rule names the receiver; the bundled tables say nothing about
// `widget-store`, so the call stays unresolved — a name is not a verdict.
const store = createStore();

export function writesThroughUnlistedPackage(): void {
  store.put("k", "v");
}
