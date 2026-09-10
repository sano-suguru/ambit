/**
 * Finding and reading the approval ledger `ambit.approvals.md`
 * (DESIGN.md §6.3).
 *
 * The reading of it — what the lines mean, and which of them are in force —
 * is `src/core/approvals.ts`, which touches no file. This module is only the
 * two lines of filesystem that stand between them, and it runs once per side
 * of a `diff`.
 */
import fs from "node:fs";
import path from "node:path";
import { APPROVALS_FILENAME, type ParsedApprovals, parseApprovals } from "../core/index.ts";

/** The ledger that governs `dir`, and what it said. */
export interface LoadedApprovals {
  /** Absolute path to the ledger, or `undefined` when there is none. */
  readonly filePath?: string;
  readonly parsed: ParsedApprovals;
}

const EMPTY: ParsedApprovals = { approvals: [], malformed: [] };

/**
 * Walk up from `startDir` looking for the ledger, stopping after the first
 * directory that holds a `package.json` or `.git`.
 *
 * The same walk `ambit.config.ts` uses (DESIGN.md §4.1 (c)), so the two files
 * agree on where the project starts — a ledger picked up from outside the
 * project would approve increases in a tree nobody reviewed.
 */
export function findApprovalsFile(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, APPROVALS_FILENAME);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    if (isProjectBoundary(dir)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isProjectBoundary(dir: string): boolean {
  return fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"));
}

/**
 * Load the ledger governing `dir`. No file is not an error: a repository with
 * no increases to approve never needs one, and the base side of the very
 * comparison that introduces the mechanism has none by definition.
 *
 * A file that exists and cannot be read *is* an error. Treating it as an empty
 * ledger would silently withdraw every approval in it, which reads as "these
 * increases were never approved" (DESIGN.md §3.4).
 *
 * @effects fs_read
 */
export function loadApprovals(dir: string): LoadedApprovals {
  const filePath = findApprovalsFile(dir);
  if (filePath === undefined) return { parsed: EMPTY };
  return { filePath, parsed: parseApprovals(fs.readFileSync(filePath, "utf8")) };
}
