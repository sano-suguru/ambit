import fs from "node:fs";

export function callsBuiltinDefaultImport(): boolean {
  return fs.existsSync("x");
}
