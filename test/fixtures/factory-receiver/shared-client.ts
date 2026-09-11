import { createStore } from "widget-store";

/** The client itself is module scope in one file and used from others. */
export const sharedStore = createStore();
