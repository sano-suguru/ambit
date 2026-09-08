import { readFileSync } from "node:fs";

export function callsBuiltinNamedImport(): void {
  readFileSync("x");
}
