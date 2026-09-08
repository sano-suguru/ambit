import { readFileSync as rf } from "node:fs";

export function callsBuiltinAliasedNamedImport(): Buffer {
  return rf("x");
}
