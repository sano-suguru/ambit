import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A base revision checked out on disk, plus the working tree it was taken from. */
export interface BaseWorktree {
  /** The temporary checkout's root. */
  readonly root: string;
  /** The repository root the ref was resolved against. */
  readonly repoRoot: string;
}

/**
 * Run `git` in `cwd` and return its stdout, trimmed.
 *
 * @effects process
 */
export async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  return (await gitRaw(cwd, ...args)).trim();
}

/**
 * The same, untrimmed — for `-z` output, where the separator is a NUL and a
 * trailing byte of a path is data rather than whitespace to be tidied away.
 *
 * @effects process
 */
export async function gitRaw(cwd: string, ...args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/**
 * The root of the repository containing `dir`.
 *
 * @effects process
 */
export async function repositoryRoot(dir: string): Promise<string> {
  return await git(dir, "rev-parse", "--show-toplevel");
}

/**
 * Check `ref` out into a temporary `git worktree` and hand the caller its
 * root. The caller must call {@link removeWorktree}, whether or not its own
 * work succeeded (DESIGN.md §6's `diff` entry).
 *
 * The checkout goes under the OS temporary directory, never inside the
 * repository, so a run that is killed outright leaves nothing in the tree
 * being analyzed.
 *
 * `node_modules` is symlinked in from the working tree when the working tree
 * has one. Measured on this repository: without it the base side resolves 19
 * more calls as unresolved and reports an `any-typed` reason the head side
 * does not have, so the two sides would differ by their environment rather
 * than by their contracts. A symlink is enough — nothing writes to it — and
 * `git worktree` never tracks it.
 *
 * The repository root is not the only place a `node_modules` can be. `subdir`
 * is the directory being compared, relative to `repoRoot`; every directory
 * from the root down to it is linked the same way, because a package inside a
 * workspace keeps its dependencies beside itself. pnpm workspaces guarantee
 * that layout — they do not hoist to the workspace root — so for a package
 * checked there the root link alone gives the base side *no* dependencies at
 * all. Measured on `immich-app/immich@2a62622`: without the chain, comparing
 * `server/src` against an unmodified tree reported 257 authority increases and
 * 1,182 unresolvable gains, all of them the two sides' environments differing
 * (`docs/measurements/2026-09-11-second-third-party-validation-immich.md`).
 *
 * @effects process, fs_read, fs_write
 */
export async function addWorktree(
  repoRoot: string,
  ref: string,
  subdir = "",
): Promise<BaseWorktree> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ambit-diff-"));
  try {
    await git(repoRoot, "worktree", "add", "--detach", root, ref);
  } catch (error) {
    // The checkout never happened, so there is no worktree to remove — only
    // the empty temporary directory this function made.
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  for (const relative of ancestry(subdir)) {
    const installed = path.join(repoRoot, relative, "node_modules");
    const link = path.join(root, relative, "node_modules");
    // The base ref need not contain the directory the working tree checks —
    // a package added since then has nothing to link into.
    if (!existsSync(installed) || !existsSync(path.join(root, relative))) continue;
    if (existsSync(link)) continue;
    await symlink(installed, link, "dir");
  }
  return { root, repoRoot };
}

/**
 * `subdir` and every directory above it, repository root first, each relative
 * to that root. The root itself is `""`, which `path.join` drops.
 *
 * `path.dirname` is what walks it, so a separator the platform writes some
 * other way is still read: the caller's `subdir` comes from `path.relative`.
 *
 * Undeclared, like `installedPackageNameOf`: `node:path` has no stub rows, so
 * a `@effects pure` here would be a declaration the analysis cannot check and
 * would report as `AMB-W001` rather than as purity.
 */
function ancestry(subdir: string): readonly string[] {
  const chain: string[] = [""];
  let current = path.normalize(subdir);
  const parts: string[] = [];
  while (current !== "" && current !== "." && current !== path.sep) {
    parts.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  chain.push(...parts);
  return chain;
}

/**
 * Remove a worktree {@link addWorktree} created, and the directory under it.
 *
 * Never throws: it runs in a `finally`, where an error would replace the
 * failure the caller is already reporting. A `git worktree remove` that fails
 * still leaves the administrative entry, so `prune` follows unconditionally
 * and the directory is removed directly as the last resort.
 *
 * @effects process, fs_write
 */
export async function removeWorktree(worktree: BaseWorktree): Promise<void> {
  try {
    await git(worktree.repoRoot, "worktree", "remove", "--force", worktree.root);
  } catch {
    // fall through to the direct removal below
  }
  await rm(worktree.root, { recursive: true, force: true });
  try {
    await git(worktree.repoRoot, "worktree", "prune");
  } catch {
    // Nothing left to do: the caller's own result is what matters here.
  }
}

/**
 * The files git reports as renamed between `ref` and the working tree, base
 * path to head path, each relative to `subdir` and separated by `"/"`.
 *
 * This is the only identity evidence `ambit diff` uses to carry a symbol
 * across a move (DESIGN.md §6.3). Two properties of `git diff` shape what it
 * can see, and both were measured rather than assumed:
 *
 * - The `-- <subdir>` pathspec restricts renames to the checked directory, and
 *   a file renamed *into* it from outside comes out as an addition, not a
 *   rename. That is the wanted reading: the checked directory did gain a
 *   symbol, whatever the rest of the repository did.
 * - Only tracked paths are compared, so a move whose destination has not been
 *   `git add`ed reads as a deletion plus an untracked file — no rename. CI
 *   always has a tracked tree; a local run may not.
 *
 * @effects process
 */
export async function renamedFiles(
  repoRoot: string,
  ref: string,
  subdir: string,
): Promise<ReadonlyMap<string, string>> {
  // `-z` rather than the default: a path is emitted raw between NULs, so a
  // path containing a quote, a tab or a non-ASCII byte survives instead of
  // arriving C-quoted.
  const raw = await gitRaw(
    repoRoot,
    "diff",
    "--find-renames",
    "--name-status",
    "-z",
    ref,
    "--",
    subdir === "" ? "." : subdir,
  );

  const fields = raw.split("\0").filter((field) => field.length > 0);
  const renames = new Map<string, string>();
  for (let i = 0; i < fields.length; ) {
    const status = fields[i] ?? "";
    // A rename or copy record spans three fields (`R100`, old, new); every
    // other status spans two.
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      if (from !== undefined && to !== undefined) {
        const fromRelative = relativeToSubdir(from, subdir);
        const toRelative = relativeToSubdir(to, subdir);
        // Both ends inside the checked directory, or the pair says nothing
        // about the comparison being made.
        if (fromRelative !== undefined && toRelative !== undefined) {
          renames.set(fromRelative, toRelative);
        }
      }
      i += 3;
    } else {
      i += 2;
    }
  }
  return renames;
}

/**
 * A repository-relative path re-expressed relative to the checked directory —
 * the form a symbol id carries (DESIGN.md §5.3) — or `undefined` when it is
 * outside that directory.
 */
function relativeToSubdir(repoPath: string, subdir: string): string | undefined {
  if (subdir === "") return repoPath;
  if (!repoPath.startsWith(`${subdir}/`)) return undefined;
  return repoPath.slice(subdir.length + 1);
}
