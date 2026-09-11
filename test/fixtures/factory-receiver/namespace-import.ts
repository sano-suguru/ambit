import * as widgets from "widget-store";

const store = widgets.createStore();

export function readsThroughNamespaceImportFactory(): string | undefined {
  return store.get("k");
}
