/**
 * Finding and reading the approval ledger `ambit.approvals.md`.
 *
 * The reading of it — what the lines mean, and which of them are in force —
 * is `src/core/approvals.ts`, which touches no file. This module is only the
 * filesystem that stands between them, and it runs once per side of a `diff`.
 */
import fs from "node:fs";
import path from "node:path";
import { APPROVALS_FILENAME, type ParsedApprovals, parseApprovals } from "../core/index.ts";

/** The ledger at a repository root, and what it said. */
export interface LoadedApprovals {
  /** Absolute path to the ledger, or `undefined` when there is none. */
  readonly filePath?: string;
  readonly parsed: ParsedApprovals;
}

const EMPTY: ParsedApprovals = { approvals: [], malformed: [] };

/**
 * Load the ledger at `root`, the root of a repository or of its base checkout.
 *
 * Only that one path is read, never a search. What can grant an approval has
 * to be fixed before a pull request exists: if the file were looked for upward
 * from the checked directory, a pull request could add a ledger nearer to the
 * code than the one the repository's review rules protect, and the argument
 * `diff` was run with would decide which file governs.
 *
 * No file is not an error: a repository with no increases to approve never
 * needs one, and the base side of the very comparison that introduces the
 * mechanism has none by definition.
 *
 * A file that exists and cannot be read *is* an error. Treating it as an empty
 * ledger would silently withdraw every approval in it, which reads as "these
 * increases were never approved" instead of reporting that the ledger could
 * not be read.
 *
 * @effects fs_read
 */
export function loadApprovals(root: string): LoadedApprovals {
  const filePath = path.join(root, APPROVALS_FILENAME);
  if (!isFile(filePath)) return { parsed: EMPTY };
  return { filePath, parsed: parseApprovals(fs.readFileSync(filePath, "utf8")) };
}

/**
 * Ledgers between the checked directory and the repository root, excluding the
 * root's own — files that are not read, returned so they can be reported.
 *
 * Only these directories are looked at because they are the ones an earlier
 * search would have read a ledger from: someone who put one there is relying
 * on it, and silently ignoring it would turn their approvals into nothing
 * without a word. A ledger anywhere else was never read and is not mentioned.
 *
 * `subdir` is relative to `root`; the paths returned are too, with `/`
 * separators, deepest first.
 *
 * @effects fs_read
 */
export function ignoredApprovalsFiles(root: string, subdir: string): readonly string[] {
  const found: string[] = [];
  let dir = path.normalize(subdir);
  while (dir !== "" && dir !== "." && dir !== path.sep) {
    const relative = path.join(dir, APPROVALS_FILENAME);
    if (isFile(path.join(root, relative))) found.push(relative.split(path.sep).join("/"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

/** @effects fs_read */
function isFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}
