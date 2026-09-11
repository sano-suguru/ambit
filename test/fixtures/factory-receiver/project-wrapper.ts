import { createStore } from "widget-store";

/**
 * A project-local wrapper around the package's factory. The binding's origin
 * is this file, and no bundled table is keyed on a path — so there is no
 * honest name to give the receiver, and the call stays unnamed.
 */
export function openStore() {
  return createStore();
}
