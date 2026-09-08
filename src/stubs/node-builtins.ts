import type { KnownEffect } from "../core/index.ts";

/**
 * Minimal effect table for common globals and Node.js builtins (DESIGN.md
 * §4.2 "エフェクト検出の根拠"). Matching is purely textual against the
 * connector layer's best-effort `calleeQualifiedName` (see
 * `src/core/backend.ts`) — a call written as `import * as f from "node:fs";
 * f.readFileSync(...)`, `import f from "node:fs"; f.readFileSync(...)`, or
 * `import { readFileSync } from "node:fs"; readFileSync(...)` are all
 * recognized: the connector layer reports the qualified name from the
 * *module specifier text* (`"node:fs"`) plus the imported property/export
 * name, not the local binding name, so a local `as` alias doesn't affect
 * matching. This is still a known simplification for this slice: a
 * destructured or re-exported binding several hops away (e.g. through a
 * barrel file) is not resolved to its originating module specifier.
 *
 * `docs/diagnostics/` and DESIGN.md §8 track stub trust levels; this table
 * is "Ambit 同梱" (bundled with Ambit itself), the highest trust level.
 */
const STUB_EFFECTS: ReadonlyMap<string, KnownEffect> = new Map([
  ["fetch", "network"],
  ["globalThis.fetch", "network"],
  ["node:http.request", "network"],
  ["node:http.get", "network"],
  ["node:https.request", "network"],
  ["node:https.get", "network"],
  ["node:net.connect", "network"],
  ["node:net.createConnection", "network"],
  ["node:fs.readFile", "fs_read"],
  ["node:fs.readFileSync", "fs_read"],
  ["node:fs.existsSync", "fs_read"],
  ["node:fs.statSync", "fs_read"],
  ["node:fs.writeFile", "fs_write"],
  ["node:fs.writeFileSync", "fs_write"],
  ["node:fs.appendFile", "fs_write"],
  ["node:fs.appendFileSync", "fs_write"],
  ["node:fs/promises.readFile", "fs_read"],
  ["node:fs/promises.writeFile", "fs_write"],
  ["node:fs/promises.appendFile", "fs_write"],
  ["node:child_process.exec", "process"],
  ["node:child_process.execSync", "process"],
  ["node:child_process.execFile", "process"],
  ["node:child_process.spawn", "process"],
  ["node:child_process.spawnSync", "process"],
  ["node:child_process.fork", "process"],
]);

export function lookupStubEffect(qualifiedName: string): KnownEffect | undefined {
  return STUB_EFFECTS.get(qualifiedName);
}
