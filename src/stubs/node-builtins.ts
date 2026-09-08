import type { KnownEffect } from "../core/index.ts";

/**
 * Minimal effect table for common globals and Node.js builtins (DESIGN.md
 * §4.2 "エフェクト検出の根拠"). Matching is purely textual against the
 * connector layer's best-effort `calleeQualifiedName` (see
 * `src/core/backend.ts`) — it does not resolve import aliases or track
 * re-exports. This is a known simplification for this slice: a call written
 * as `import * as f from "node:fs"; f.readFileSync(...)` is recognized
 * because the connector layer reports the qualified name from the *module
 * specifier text* (`"node:fs"`) rather than the local binding name, but an
 * aliased or destructured re-export several hops away may not be.
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
