import { createIndex } from "widget-store";

// The result's type is declared by the compiler's own lib, so the receiver
// gets no package-qualified name and `get` stays on the pure-builtin path.
const index = createIndex();

export function readsThroughDefaultLibResult(): number | undefined {
  return index.get("k");
}
