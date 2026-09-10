import type nodeFs from "node:fs";
import type nodeFsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCapabilities } from "./enforce.ts";

/**
 * `require`, not `import`, and the difference is load-bearing.
 *
 * A builtin's ESM namespace is a snapshot of its properties taken when that
 * builtin is first `import`ed. `import fs from "node:fs"` here would take
 * that snapshot before this module has patched anything, and every
 * `import { readFileSync } from "node:fs"` in the application would then be
 * bound to the original — even from a preload. Reaching the module through
 * `createRequire` leaves the snapshot to be taken later, from the patched object,
 * which is what makes §4.4 (a)'s preload row true. Measured both ways.
 */
const requireBuiltin = createRequire(import.meta.url);
const fs = requireBuiltin("node:fs") as typeof nodeFs;
const fsPromises = requireBuiltin("node:fs/promises") as typeof nodeFsPromises;

/**
 * Runtime enforcement for `node:fs` and `node:fs/promises` (DESIGN.md §4.4
 * (a), (b)).
 *
 * The mechanism is a monkeypatch of the module's own exports object, chosen
 * over `diagnostics_channel` (which cannot block: a subscriber's `throw` does
 * not stop `publish`) and over a loader hook (which covers nothing a
 * monkeypatch does not). What a monkeypatch covers depends on *when* it is
 * installed, not on the mechanism:
 *
 * - installed before anything has `import`ed `node:fs` — from a
 *   `node --import` / `--require` preload — every form is covered, named ESM
 *   imports included;
 * - installed from inside the module graph, every `fs.readFile()` through the
 *   default export or `requireBuiltin("node:fs")`, but not a named import
 *   (`import { readFile } from "node:fs"`) that was already bound.
 *
 * `docs/limitations.md` states both, and neither covers native addons, a
 * child process, or another worker thread.
 */

/** Which paths an operation reads and which it writes, by argument position. */
interface FsRule {
  readonly reads?: readonly number[];
  readonly writes?: readonly number[];
}

/**
 * The operations this hook checks. Anything absent is not checked and not
 * recorded — `docs/limitations.md` lists what that leaves out rather than
 * letting the omission read as "allowed".
 *
 * `open` is checked by flags rather than by name, so it appears in
 * {@link FLAG_OPERATIONS} instead. `createReadStream` / `createWriteStream`
 * are absent on purpose: both go through `fs.open`, which this hook replaces,
 * so they are covered at that entry point (measured).
 */
const OPERATIONS: ReadonlyMap<string, FsRule> = new Map<string, FsRule>([
  ["readFile", { reads: [0] }],
  ["readdir", { reads: [0] }],
  ["access", { reads: [0] }],
  ["stat", { reads: [0] }],
  ["lstat", { reads: [0] }],
  ["realpath", { reads: [0] }],
  ["readlink", { reads: [0] }],
  ["writeFile", { writes: [0] }],
  ["appendFile", { writes: [0] }],
  ["mkdir", { writes: [0] }],
  ["rmdir", { writes: [0] }],
  ["rm", { writes: [0] }],
  ["unlink", { writes: [0] }],
  ["truncate", { writes: [0] }],
  ["chmod", { writes: [0] }],
  ["symlink", { writes: [1] }],
  ["rename", { reads: [0], writes: [1] }],
  ["copyFile", { reads: [0], writes: [1] }],
  ["link", { reads: [0], writes: [1] }],
]);

/** `open` decides its direction from `flags`, so it is handled apart from {@link OPERATIONS}. */
const FLAG_OPERATIONS: ReadonlySet<string> = new Set(["open"]);

/**
 * `existsSync` is the one read that must not answer `false` when denied
 * (DESIGN.md §4.4 (a)): "not there" and "not allowed to look" are different
 * answers, and returning `false` would report the second as the first.
 */
const SYNC_ONLY: ReadonlySet<string> = new Set(["existsSync"]);

/**
 * The capabilities one path argument needs. Exported so a caller can see
 * exactly what a given path resolves to before granting it.
 *
 * Relative paths resolve against `process.cwd()` *at the time of the call*,
 * `Buffer` paths are decoded, and a `file:` URL is converted — §4.4 (b)'s
 * normalisation, so that one file has one spelling in a grant.
 */
export function fsCapabilities(rule: FsRule, args: readonly unknown[]): readonly string[] {
  const required: string[] = [];
  for (const index of rule.reads ?? []) {
    const target = normalizePath(args[index]);
    if (target !== undefined) required.push(`fs:read:${target}`);
  }
  for (const index of rule.writes ?? []) {
    const target = normalizePath(args[index]);
    if (target !== undefined) required.push(`fs:write:${target}`);
  }
  return required;
}

/**
 * `undefined` for an argument that names no path — a file descriptor, which
 * `fs.readSync(fd)` takes. The path was checked when the descriptor was
 * opened; checking it again here is impossible, not merely skipped.
 */
function normalizePath(value: unknown): string | undefined {
  if (typeof value === "number") return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else if (value instanceof URL) text = fileURLToPath(value);
  else if (Buffer.isBuffer(value)) text = value.toString("utf8");
  else return undefined;
  return path.resolve(text);
}

/** The capabilities an `open` needs, from its `flags` argument (default `"r"`). */
export function openCapabilities(args: readonly unknown[]): readonly string[] {
  const target = normalizePath(args[0]);
  if (target === undefined) return [];
  const flags = args[1];
  const rule = openFlagsRule(flags);
  return fsCapabilities(rule, [target, target]);
}

function openFlagsRule(flags: unknown): FsRule {
  // A missing or non-flag second argument means the default, `"r"`.
  if (typeof flags === "number") {
    const access = flags & 0b11;
    if (access === fs.constants.O_WRONLY) return { writes: [1] };
    if (access === fs.constants.O_RDWR) return { reads: [0], writes: [1] };
    return { reads: [0] };
  }
  if (typeof flags !== "string") return { reads: [0] };
  const reads = flags.startsWith("r") || flags.includes("+");
  const writes = flags.includes("w") || flags.includes("a") || flags.includes("+");
  return {
    ...(reads ? { reads: [0] } : {}),
    ...(writes ? { writes: [1] } : {}),
  };
}

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * Replace the checked members of `node:fs` and `node:fs/promises`, returning
 * the function that puts every one of them back.
 *
 * Same shape as `installFetchHook`: install returns restore, and restore only
 * undoes what is still ours, so a hook installed on top of this one is not
 * clobbered (P5: backing out at any time).
 */
export function installFsHook(): () => void {
  const restores: (() => void)[] = [];

  for (const [name, rule] of OPERATIONS) {
    patch(fs, name, (args) => fsCapabilities(rule, args), "callback", restores);
    patch(fs, `${name}Sync`, (args) => fsCapabilities(rule, args), "sync", restores);
    patch(fsPromises, name, (args) => fsCapabilities(rule, args), "promise", restores);
  }
  for (const name of FLAG_OPERATIONS) {
    patch(fs, name, openCapabilities, "callback", restores);
    patch(fs, `${name}Sync`, openCapabilities, "sync", restores);
    patch(fsPromises, name, openCapabilities, "promise", restores);
  }
  for (const name of SYNC_ONLY) {
    patch(fs, name, (args) => fsCapabilities({ reads: [0] }, args), "sync", restores);
  }

  return () => {
    for (const restore of restores) restore();
  };
}

/**
 * Deliver a denial the way the API's own errors arrive: `throw` for the sync
 * family, `process.nextTick(callback, error)` for the callback family, a
 * rejected promise for `fs/promises` (DESIGN.md §4.4 (a)). A callback API that
 * threw synchronously would break `try`/`catch`-free call sites that are
 * correct as written.
 */
function patch(
  host: Record<string, unknown>,
  name: string,
  capabilities: (args: readonly unknown[]) => readonly string[],
  family: "sync" | "callback" | "promise",
  restores: (() => void)[],
): void {
  const original = host[name];
  if (typeof original !== "function") return;
  const target = original as AnyFunction;

  const hooked = function (this: unknown, ...args: unknown[]): unknown {
    const error = checkCapabilities(capabilities(args));
    if (!error) return target.apply(this, args);
    if (family === "promise") return Promise.reject(error);
    if (family === "callback") {
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        process.nextTick(callback as AnyFunction, error);
        return undefined;
      }
    }
    throw error;
  };
  Object.defineProperty(hooked, "name", { value: name });
  host[name] = hooked;
  restores.push(() => {
    if (host[name] === hooked) host[name] = original;
  });
}
