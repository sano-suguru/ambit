import path from "node:path";
import type { AuthorityDiff } from "../core/index.ts";
import {
  authorityDecreases,
  authorityIncreases,
  deletedSymbols,
  diffAuthority,
  unchangedSymbols,
} from "../core/index.ts";
import { analyze } from "./analyze.ts";
import { addWorktree, git, removeWorktree, repositoryRoot } from "./worktree.ts";

/** What `ambit diff` compared, and what came out. */
export interface DiffResult {
  readonly diff: AuthorityDiff;
  /** The ref as given, and the commit it resolved to — a branch name moves, a sha does not. */
  readonly ref: string;
  readonly baseCommit: string;
  /** The directory that was compared, relative to the repository root. */
  readonly subdir: string;
}

/**
 * Compare the working tree's authority against `ref`.
 *
 * The base side is a `git worktree` checkout under the OS temporary
 * directory; both sides then run the same {@link analyze} over the same
 * subdirectory, and the two dumps go to `diffAuthority`, which is pure. Git
 * appears here and nowhere in the comparison.
 *
 * The worktree is removed in a `finally`, so a failed analysis leaves nothing
 * behind either.
 *
 * @effects process, fs_read, fs_write
 */
export async function runDiff(ref: string, dir: string): Promise<DiffResult> {
  const repoRoot = await repositoryRoot(dir);
  // Resolved before the checkout so a bad ref fails with git's own message
  // rather than as a half-made worktree.
  const baseCommit = await git(repoRoot, "rev-parse", ref);
  const subdir = path.relative(repoRoot, path.resolve(dir));

  const worktree = await addWorktree(repoRoot, baseCommit);
  try {
    // The same subpath on both sides: a symbol id is relative to the
    // directory that was checked (DESIGN.md §5.3), so comparing `src` against
    // a whole repository would make every id look new.
    const base = await analyze(path.join(worktree.root, subdir));
    const head = await analyze(path.resolve(dir));
    return { diff: diffAuthority(base.authority, head.authority), ref, baseCommit, subdir };
  } finally {
    await removeWorktree(worktree);
  }
}

/**
 * What was compared and what changed, in counts.
 *
 * Every symbol either side knows about falls into exactly one of these, so a
 * reader can see that nothing was dropped on the way.
 */
export function formatDiffText(result: DiffResult): string {
  const { diff } = result;
  const where = result.subdir === "" ? "the repository root" : result.subdir;
  return [
    `base ${result.ref} (${result.baseCommit.slice(0, 7)}) vs the working tree, over ${where}`,
    `symbols=${diff.symbols.length} increased=${authorityIncreases(diff).length} decreased=${authorityDecreases(diff).length} deleted=${deletedSymbols(diff).length} unchanged=${unchangedSymbols(diff).length}`,
    "",
  ].join("\n");
}
