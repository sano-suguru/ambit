import path from "node:path";
import type { AuthorityDiff, AuthorityRef, SymbolAuthorityDiff } from "../core/index.ts";
import {
  authorityDecreases,
  authorityIncreases,
  deletedSymbols,
  diffAuthority,
  displayName,
  pathFor,
  unchangedSymbols,
  unknownGained,
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
 * The comparison, for a human reading a pull request.
 *
 * What increased comes first and is the only part rendered in full: each
 * added authority gets the call path that brought it, so the reader sees the
 * hop that introduced it without opening anything. What decreased, what was
 * deleted and what stayed the same follow, named or counted but never
 * expanded — the point of the command is that nobody has to read every
 * contract to find the one that changed.
 */
export function formatDiffText(result: DiffResult): string {
  const { diff } = result;
  const increases = authorityIncreases(diff);
  const decreases = authorityDecreases(diff);
  const deleted = deletedSymbols(diff);
  const unknown = unknownGained(diff);
  const where = result.subdir === "" ? "the repository root" : result.subdir;

  const lines: string[] = [
    `base ${result.ref} (${result.baseCommit.slice(0, 7)}) vs the working tree, over ${where}`,
    "",
  ];

  if (increases.length === 0) {
    lines.push("No authority increased.", "");
  } else {
    lines.push(`Authority increased in ${count(increases.length, "symbol")}:`, "");
    for (const entry of increases) {
      lines.push(...renderIncrease(entry));
    }
  }

  // Not an increase — `unknown` is not authority (DESIGN.md §4.3) — but never
  // silent either: a range that stopped being analyzable is exactly what must
  // not be reported as "nothing increased here".
  if (unknown.length > 0) {
    lines.push(
      `Analysis reached something it could not resolve in ${count(unknown.length, "symbol")} where it previously did not.`,
      "This is not authority and is not counted as an increase; those symbols' effects may be incomplete:",
      ...unknown.map((entry) => `  ${entry.symbol}`),
      "",
    );
  }

  if (decreases.length > 0) {
    lines.push(`Authority decreased in ${count(decreases.length, "symbol")}:`);
    for (const entry of decreases) {
      lines.push(`  ${entry.symbol}`, ...entry.removed.map((ref) => `    - ${refText(ref)}`));
    }
    lines.push("");
  }

  if (deleted.length > 0) {
    lines.push(
      `${count(deleted.length, "symbol")} no longer present:`,
      ...deleted.map((entry) => `  ${entry.symbol}`),
      "",
    );
  }

  lines.push(
    `${count(unchangedSymbols(diff).length, "symbol")} unchanged, out of ${count(diff.symbols.length, "symbol")} compared.`,
    "",
  );
  return lines.join("\n");
}

/**
 * One increased symbol: the symbol at its own position, then each authority
 * it gained with the path that carries it.
 *
 * A path is shown only where the record has one. An authority a function
 * declares but does not reach has no path, and none is invented
 * (DESIGN.md §5.3).
 */
function renderIncrease(entry: SymbolAuthorityDiff): readonly string[] {
  const at = entry.head ? ` (${entry.head.location.file}:${entry.head.location.line})` : "";
  const isNew = entry.status === "new" ? "  [new symbol]" : "";
  const lines = [`  ${entry.symbol}${at}${isNew}`];
  for (const ref of entry.added) {
    lines.push(`    + ${refText(ref)}`);
    const path = pathFor(entry.head, ref);
    for (const hop of path?.via ?? []) {
      lines.push(`      -> ${displayName(hop.symbol)} (${hop.file}:${hop.line})`);
    }
    if (path?.operation) {
      lines.push(
        `      operation: ${path.operation.qualifiedName} (${path.operation.file}:${path.operation.line})`,
      );
    }
  }
  lines.push("");
  return lines;
}

/**
 * An authority as a reader recognizes it: an effect by its bare name, a
 * capability prefixed so the two lattices never read as one namespace.
 */
function refText(ref: AuthorityRef): string {
  return ref.kind === "effect" ? ref.name : `capability ${ref.name}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
