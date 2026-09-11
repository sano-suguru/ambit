import { createStore } from "widget-store";

/**
 * A project-local wrapper around the package's factory. The binding's origin
 * is this file, and no bundled table is keyed on a path — so the factory rule
 * names nothing here. What the caller holds is still the package's own
 * `Store`, which is what names the call instead.
 */
export function openStore() {
  return createStore();
}
