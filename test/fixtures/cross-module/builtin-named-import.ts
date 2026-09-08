import { readdirSync } from "node:fs";

export function callsBuiltinNamedImport(): void {
  readdirSync("x");
}
