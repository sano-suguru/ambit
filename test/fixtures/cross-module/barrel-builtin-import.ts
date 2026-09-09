import { readFileSync } from "./index.ts";

/** @effects pure */
export function pureCallsBarrelImportedBuiltin(): string {
  return readFileSync("x", "utf8");
}
