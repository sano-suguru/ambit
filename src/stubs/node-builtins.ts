import type { KnownEffect } from "../core/index.ts";

/**
 * Minimal effect table for common globals, Node.js builtins, and a handful
 * of widely-used third-party packages (DESIGN.md §4.2, "Evidence for effect
 * detection", lists both as legitimate sources — the same table, not a
 * separate one).
 * Matching is purely textual against the connector layer's best-effort
 * `calleeQualifiedName` (see `src/core/backend.ts`) — a call written as
 * `import * as f from "node:fs"; f.readFileSync(...)`, `import f from
 * "node:fs"; f.readFileSync(...)`, or `import { readFileSync } from
 * "node:fs"; readFileSync(...)` are all recognized: the connector layer
 * reports the qualified name from the *module specifier text* (`"node:fs"`)
 * plus the imported property/export name, not the local binding name, so a
 * local `as` alias doesn't affect matching. This is still a known
 * simplification for this slice: a destructured or re-exported binding
 * several hops away (e.g. through a barrel file) is not resolved to its
 * originating module specifier.
 *
 * `docs/diagnostics/` and DESIGN.md §8 track stub trust levels; this table
 * is bundled with Ambit itself, the highest trust level.
 */
const STUB_EFFECTS: ReadonlyMap<string, KnownEffect> = new Map([
  ["fetch", "network"],
  ["globalThis.fetch", "network"],
  ["undici.fetch", "network"],
  // ky — the same operation as `fetch`, through the client measurement
  // surfaced in the third-party backend this table is measured against
  // (Unleash, `src/lib`: `ky(…)`, `ky.get(…)`, `ky.post(…)`, all three
  // through the default export). Read off `ky@1.14.3`'s own types: the
  // module's default export is a `KyInstance`, whose call signature is
  // `<T>(url: Input, options?: Options)` — named `ky.default` here, since a
  // default export has no name of its own — and whose `get` / `post` / `put` /
  // `patch` / `delete` / `head` are the documented request methods. Each one
  // sends; `create` and `extend` return a new instance and send nothing, so
  // they have no row and stay `unknown` rather than being called effect-free.
  ["ky.default", "network"],
  ["ky.get", "network"],
  ["ky.post", "network"],
  ["ky.put", "network"],
  ["ky.patch", "network"],
  ["ky.delete", "network"],
  ["ky.head", "network"],
  ["node:http.request", "network"],
  ["node:http.get", "network"],
  ["node:https.request", "network"],
  ["node:https.get", "network"],
  ["node:net.connect", "network"],
  ["node:net.createConnection", "network"],
  ["node:fs.readFile", "fs_read"],
  ["node:fs.readdir", "fs_read"],
  ["node:fs.readdirSync", "fs_read"],
  ["node:fs.realpath", "fs_read"],
  ["node:fs.realpathSync", "fs_read"],
  ["node:fs.stat", "fs_read"],
  ["node:fs.lstat", "fs_read"],
  ["node:fs.lstatSync", "fs_read"],
  ["node:fs.access", "fs_read"],
  ["node:fs.accessSync", "fs_read"],
  ["node:fs.readFileSync", "fs_read"],
  ["node:fs.existsSync", "fs_read"],
  ["node:fs.statSync", "fs_read"],
  ["node:fs.writeFile", "fs_write"],
  ["node:fs.writeFileSync", "fs_write"],
  ["node:fs.appendFile", "fs_write"],
  ["node:fs.appendFileSync", "fs_write"],
  ["node:fs.mkdir", "fs_write"],
  ["node:fs.mkdirSync", "fs_write"],
  ["node:fs.mkdtemp", "fs_write"],
  ["node:fs.mkdtempSync", "fs_write"],
  ["node:fs.rm", "fs_write"],
  ["node:fs.rmSync", "fs_write"],
  ["node:fs.unlink", "fs_write"],
  ["node:fs.unlinkSync", "fs_write"],
  ["node:fs/promises.readFile", "fs_read"],
  ["node:fs/promises.readdir", "fs_read"],
  ["node:fs/promises.realpath", "fs_read"],
  ["node:fs/promises.stat", "fs_read"],
  ["node:fs/promises.lstat", "fs_read"],
  ["node:fs/promises.access", "fs_read"],
  ["node:fs/promises.writeFile", "fs_write"],
  ["node:fs/promises.appendFile", "fs_write"],
  ["node:fs/promises.mkdir", "fs_write"],
  ["node:fs/promises.mkdtemp", "fs_write"],
  ["node:fs/promises.rm", "fs_write"],
  ["node:fs/promises.unlink", "fs_write"],
  ["node:child_process.exec", "process"],
  ["node:child_process.execSync", "process"],
  ["node:child_process.execFile", "process"],
  ["node:child_process.spawn", "process"],
  ["node:child_process.spawnSync", "process"],
  ["node:child_process.fork", "process"],
]);

/**
 * The Node.js builtin modules the bundled tables key on, spelled without the
 * `node:` prefix.
 *
 * Both spellings name the same module: Node resolves a bare builtin specifier
 * to the builtin before it looks at `node_modules`, so `from "fs"` and `from
 * "node:fs"` cannot be different modules. The tables are keyed on the prefixed
 * spelling, and the name a call arrives with is the specifier the *source*
 * wrote — so before {@link withNodePrefix}, the same edit failed the check
 * written one way and passed written the other (measured, E3b:
 * `docs/measurements/2026-09-11-third-party-diff-validation.md`). The prefix is
 * a spelling, not a fact about the operation, so it is normalized at lookup
 * rather than duplicated as a second set of rows.
 *
 * Only the builtins a bundled table actually has a row for are listed: a
 * specifier no table answers needs no canonical form, and a name built from
 * one keeps the spelling its source wrote in the coverage histogram. Which
 * builtins those are is checked rather than remembered —
 * `test/stubs.node-builtins.test.ts` fails if any table grows a `node:` row
 * this set does not cover.
 */
const PREFIXABLE_BUILTIN_SPECIFIERS: ReadonlySet<string> = new Set([
  "child_process",
  "fs",
  "fs/promises",
  "http",
  "https",
  "net",
  "tls",
  "worker_threads",
]);

/**
 * `qualifiedName` with the `node:` prefix its module specifier may have been
 * written without, and unchanged for every other name.
 *
 * The specifier is the part before the first `"."` — `fs/promises.readFile`
 * included, whose specifier carries a `/` but no `.`.
 */
export function withNodePrefix(qualifiedName: string): string {
  const separator = qualifiedName.indexOf(".");
  if (separator < 0) return qualifiedName;
  const specifier = qualifiedName.slice(0, separator);
  return PREFIXABLE_BUILTIN_SPECIFIERS.has(specifier) ? `node:${qualifiedName}` : qualifiedName;
}

export function lookupStubEffect(qualifiedName: string): KnownEffect | undefined {
  return STUB_EFFECTS.get(withNodePrefix(qualifiedName));
}
