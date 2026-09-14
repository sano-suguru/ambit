// The tsconfig beside this file names no `types`, the shape a TypeScript 5
// project is written in. `@types/node` is installed (at the repository root),
// so the import resolves for the compiler the project was written against.
import { writeFileSync } from "node:fs";

/** @effects pure */
export function writesAuditLog(total: number): number {
  writeFileSync("audit.log", String(total));
  return total;
}
