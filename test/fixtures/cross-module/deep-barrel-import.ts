import { readFileSync } from "./deep-barrel.ts";

export function callsTwiceReExportedBuiltin(): string {
  return readFileSync("x", "utf8");
}
