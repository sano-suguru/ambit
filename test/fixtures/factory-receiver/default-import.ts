import widgets from "widget-store";

const store = widgets.createStore();

export function readsThroughDefaultImportFactory(): string | undefined {
  return store.get("k");
}
