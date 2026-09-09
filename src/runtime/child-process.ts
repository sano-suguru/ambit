import type nodeChildProcess from "node:child_process";
import { createRequire } from "node:module";
import { checkCapability } from "./enforce.ts";

/** `createRequire` rather than `import`, for the reason `fs.ts` documents. */
const requireBuiltin = createRequire(import.meta.url);
const childProcess = requireBuiltin("node:child_process") as typeof nodeChildProcess;

/**
 * Runtime enforcement for `node:child_process` (DESIGN.md §4.4 (a), (b)).
 *
 * Same monkeypatch mechanism and the same install-order caveat as
 * {@link installFsHook}: installed from a preload it covers named ESM imports
 * too; installed from inside the module graph it covers the default export and
 * `requireBuiltin("node:child_process")`, not a named import already bound. It never
 * covers what happens *inside* the child.
 */

/** The default shell `exec` uses when `options.shell` does not name one. */
const DEFAULT_SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/sh";

/**
 * Why a shell spawn cannot name the program that runs. Carried into the
 * exception text because DESIGN.md §4.4 requires an operation Ambit cannot
 * decide to say so where the user reads it, not only in the docs.
 */
const SHELL_DETAIL =
  "this spawns a shell, and the granted shell can run any program: the capability names the shell, not the program in the command string";

export interface SpawnRequirement {
  readonly capability: string;
  readonly detail?: string;
}

/**
 * The capability one `child_process` call requires.
 *
 * `spawn`, `execFile` and their `Sync` forms name their program in argv[0],
 * and it is taken **as written** — no `PATH` lookup, because resolving it
 * would mean reading the filesystem to answer a question about a string, and
 * the answer would depend on the environment rather than on the call.
 *
 * `exec`, `execSync`, and any form with `shell: true` run a shell. Which
 * program the shell then runs is inside a shell command string, and naming it
 * would need a shell parser — the same claim §4.4 forbids for table names
 * inside arbitrary SQL. So the capability names the shell, and the exception
 * says exactly that.
 */
export function spawnCapability(
  kind: "spawn" | "exec" | "fork",
  args: readonly unknown[],
): SpawnRequirement {
  if (kind === "fork") {
    // A fork always runs this Node binary; the module path is an argument to it.
    return { capability: `proc:spawn:${process.execPath}` };
  }
  const shell = shellOption(args);
  if (kind === "exec" || shell !== undefined) {
    return { capability: `proc:spawn:${shell ?? DEFAULT_SHELL}`, detail: SHELL_DETAIL };
  }
  const command = typeof args[0] === "string" ? args[0] : undefined;
  if (command === undefined) {
    return {
      capability: "proc:spawn:unknown",
      detail: "the command is not a string in this call, so it cannot be named",
    };
  }
  return { capability: `proc:spawn:${command}` };
}

/**
 * `options.shell` when the call asks for a shell, `undefined` when it does
 * not. `shell: true` means the platform default.
 */
function shellOption(args: readonly unknown[]): string | undefined {
  for (const argument of args.slice(1)) {
    if (argument === null || typeof argument !== "object" || Array.isArray(argument)) continue;
    const shell = (argument as { shell?: unknown }).shell;
    if (typeof shell === "string") return shell;
    if (shell === true) return DEFAULT_SHELL;
    return undefined;
  }
  return undefined;
}

/** Which member takes which shape of argument, and how a denial is delivered. */
const OPERATIONS: readonly {
  readonly name: string;
  readonly kind: "spawn" | "exec" | "fork";
  readonly family: "sync" | "callback";
}[] = [
  { name: "spawn", kind: "spawn", family: "sync" },
  { name: "spawnSync", kind: "spawn", family: "sync" },
  { name: "execFile", kind: "spawn", family: "callback" },
  { name: "execFileSync", kind: "spawn", family: "sync" },
  { name: "exec", kind: "exec", family: "callback" },
  { name: "execSync", kind: "exec", family: "sync" },
  { name: "fork", kind: "fork", family: "sync" },
];

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * Replace the checked members of `node:child_process`, returning the function
 * that puts them back — the shape `installFetchHook` established.
 *
 * `spawn` and `fork` have no callback to hand an error to and return a
 * `ChildProcess` rather than a result, so a denial throws; `exec` and
 * `execFile` deliver through their callback when one is present, which is
 * §4.4 (a)'s rule for the callback family.
 */
export function installChildProcessHook(): () => void {
  const host = childProcess as unknown as Record<string, unknown>;
  const restores: (() => void)[] = [];

  for (const { name, kind, family } of OPERATIONS) {
    const original = host[name];
    if (typeof original !== "function") continue;
    const target = original as AnyFunction;

    const hooked = function (this: unknown, ...args: unknown[]): unknown {
      const { capability, detail } = spawnCapability(kind, args);
      const error = checkCapability(capability, detail);
      if (!error) return target.apply(this, args);
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

  return () => {
    for (const restore of restores) restore();
  };
}
