/**
 * The approval ledger: reading `ambit.approvals.md` and deciding which
 * authority increases it lets through (DESIGN.md §6.3).
 *
 * Pure, like `authority-diff.ts` beside it. Text in, decisions out — nothing
 * here opens a file or runs git, so the whole rule that governs whether a
 * pull request passes can be unit tested without a repository.
 */
import type { AuthorityRef } from "./authority.ts";
import { formatAuthorityRef } from "./authority.ts";
import type { AuthorityDiff, SymbolAuthorityDiff } from "./authority-diff.ts";
import { authorityIncreases } from "./authority-diff.ts";
import type { SymbolId } from "./symbol-id.ts";

/** One parsed approval line. */
export interface Approval {
  readonly symbol: SymbolId;
  readonly authority: AuthorityRef;
  /** Why the increase was accepted. Free text, required — an approval with no reason records nothing. */
  readonly reason: string;
  /** 1-based line in the ledger, so a report can point at it. */
  readonly line: number;
}

/** A `-` line that is not an approval. Reported, and grants nothing. */
export interface MalformedApprovalLine {
  readonly line: number;
  readonly text: string;
}

export interface ParsedApprovals {
  readonly approvals: readonly Approval[];
  readonly malformed: readonly MalformedApprovalLine[];
}

/**
 * The ledger's name. Exactly one file with it is read: the one at the
 * repository root. A copy anywhere below grants nothing.
 */
export const APPROVALS_FILENAME = "ambit.approvals.md";

/**
 * `- \`<symbol id>\` \`<authority>\` — <reason>`.
 *
 * The two fields are code spans rather than whitespace-separated tokens
 * because a symbol id contains a file path, and a path may contain spaces.
 * Any of `—`, `--`, `-` or `:` separates the reason, or nothing does; the
 * reason itself is required.
 */
const APPROVAL_LINE = /^\s*-\s+`([^`]+)`\s+`([^`]+)`\s*(?:[-—:]+\s*)?(\S.*?)\s*$/;

/**
 * A reason made only of separators, whitespace and invisible format characters
 * says nothing. The separator is optional in `APPROVAL_LINE`, so without this a
 * bare `—` would be captured as the reason itself.
 */
const EMPTY_REASON = /^[\s\p{Cf}\-—:]*$/u;

/** The heading the approvals live under. Everything above it is prose, bullets included. */
const APPROVALS_HEADING = /^#+\s+Approvals\s*$/;

/**
 * Read a ledger.
 *
 * Approvals are the lines whose first non-space character is `-`, below the
 * `Approvals` heading; everything else is prose, so the file explains itself
 * to the person reading the pull request — and can use a bullet list to do it,
 * which is why the heading is needed at all. A file with no such heading is
 * read as approvals throughout, so a ledger that is nothing but lines works.
 *
 * A `-` line inside the region that does not parse is *not* silently demoted
 * to prose — that would turn a typo in an approval into an approval that does
 * nothing and says nothing (DESIGN.md §3.4) — it is returned as malformed.
 */
export function parseApprovals(text: string): ParsedApprovals {
  const approvals: Approval[] = [];
  const malformed: MalformedApprovalLine[] = [];

  const lines = text.split(/\r?\n/);
  let inRegion = !lines.some((raw) => APPROVALS_HEADING.test(raw));
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    if (APPROVALS_HEADING.test(raw)) {
      inRegion = true;
      continue;
    }
    if (!inRegion || !raw.trimStart().startsWith("-")) continue;

    const match = APPROVAL_LINE.exec(raw);
    const authority = match ? parseAuthorityRef(match[2] ?? "") : undefined;
    if (!match || !authority || EMPTY_REASON.test(match[3] ?? "")) {
      malformed.push({ line, text: raw.trim() });
      continue;
    }
    approvals.push({
      symbol: (match[1] ?? "") as SymbolId,
      authority,
      reason: match[3] ?? "",
      line,
    });
  }
  return { approvals, malformed };
}

/**
 * `effect:<name>` or `capability:<resource>:<action>:<target>` — the same text
 * {@link formatAuthorityRef} writes, which is the text `ambit diff` prints.
 *
 * The name is not validated against the known effects: a config file can
 * define its own (DESIGN.md §4.1), and an approval naming something no
 * increase carries is reported as granting nothing rather than as an error
 * about a vocabulary this module does not own.
 */
function parseAuthorityRef(token: string): AuthorityRef | undefined {
  const separator = token.indexOf(":");
  if (separator <= 0) return undefined;
  const kind = token.slice(0, separator);
  const name = token.slice(separator + 1);
  if (name.length === 0) return undefined;
  if (kind !== "effect" && kind !== "capability") return undefined;
  return { kind, name };
}

/**
 * The identity an approval line names: the analysis's symbol id, which is
 * relative to the directory that was checked, re-rooted at the repository root.
 *
 * The ledger is one file for the whole repository, so what a line names has to
 * be unique across the whole repository too. Left relative to the checked
 * directory, `src/client.ts#fetch` in `packages/a` and in `packages/b` would be
 * one key, and a line written for one package would approve the other. The
 * directory decides what is analyzed; it must not decide which symbol a line
 * approves, so `diff <ref> packages/a` and `diff <ref> .` name the same function
 * the same way.
 *
 * `subdir` is the checked directory relative to the repository root, with `/`
 * separators; `""` is the root itself.
 */
export function approvalSymbolId(subdir: string, symbol: SymbolId): SymbolId {
  const prefix = subdir
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return (prefix === "" ? symbol : `${prefix}/${symbol}`) as SymbolId;
}

/** The line to add to the ledger for one increase — what `ambit diff` prints to be copied. */
export function formatApprovalLine(
  symbol: SymbolId,
  ref: AuthorityRef,
  reason = "<why this increase is correct>",
): string {
  return `- \`${symbol}\` \`${formatAuthorityRef(ref)}\` — ${reason}`;
}

/**
 * The key an approval and an increase are matched on: exact text, both halves.
 *
 * Capability containment is deliberately not used. Containment describes how a
 * grant relates to a requirement (DESIGN.md §4.4); an approval is neither, and
 * letting one line cover a family of increases would approve increases nobody
 * read (§6.3).
 */
function approvalKey(symbol: SymbolId, ref: AuthorityRef): string {
  return `${symbol}\u0000${formatAuthorityRef(ref)}`;
}

/** One authority one symbol gained — the unit an approval line is written for. */
export interface IncreaseItem {
  readonly entry: SymbolAuthorityDiff;
  readonly ref: AuthorityRef;
}

export interface ApprovedIncrease extends IncreaseItem {
  readonly approval: Approval;
}

export interface ApprovalReview {
  /** Increases carrying an approval added in this comparison. Reported; not a failure. */
  readonly approved: readonly ApprovedIncrease[];
  /** Increases with nothing to approve them. This is what fails a check. */
  readonly unapproved: readonly IncreaseItem[];
  /**
   * Approvals added in this comparison that matched no increase — a mistyped
   * symbol id or authority, most often. Reported, never a failure on its own:
   * whatever the line was meant to approve is still unapproved, and that is
   * what fails.
   */
  readonly unused: readonly Approval[];
}

/**
 * Decide, for every increase in `diff`, whether the ledger approves it.
 *
 * An approval is in force only in the comparison that adds it: the count of
 * approvals for a `(symbol, authority)` pair is the head side's count minus
 * the base side's, and the *last* that many head-side lines are the ones that
 * count. So a line already merged grants nothing, re-approving a pair later is
 * appending a second identical line, and deleting a line can only ever lower
 * what is approved (DESIGN.md §6.3).
 *
 * Both sides' lines are read from the same ledger file, one in the working
 * tree and one in the base checkout. `subdir` is where `diff` was checked,
 * relative to the repository root: an increase is matched under
 * {@link approvalSymbolId}, and a line is taken as written.
 */
export function reviewIncreases(
  diff: AuthorityDiff,
  base: readonly Approval[],
  head: readonly Approval[],
  subdir: string,
): ApprovalReview {
  const baseCount = new Map<string, number>();
  for (const approval of base) {
    const key = approvalKey(approval.symbol, approval.authority);
    baseCount.set(key, (baseCount.get(key) ?? 0) + 1);
  }

  const headByKey = new Map<string, readonly Approval[]>();
  for (const approval of head) {
    const key = approvalKey(approval.symbol, approval.authority);
    headByKey.set(key, [...(headByKey.get(key) ?? []), approval]);
  }

  // The head side's later lines are the ones in force: the first `spent` of
  // them are the copies already in the base, and those grant nothing.
  const inForce = new Map<string, readonly Approval[]>();
  for (const [key, bucket] of headByKey) {
    const spent = baseCount.get(key) ?? 0;
    if (bucket.length > spent) inForce.set(key, bucket.slice(spent));
  }

  // A cursor per key rather than shifting the bucket: a `readonly` array read
  // out of a map is not this function's to mutate, and rebuilding one per
  // increase would be the same statement written more expensively.
  const taken = new Map<string, number>();
  const approved: ApprovedIncrease[] = [];
  const unapproved: IncreaseItem[] = [];
  for (const entry of authorityIncreases(diff)) {
    for (const ref of entry.added) {
      const key = approvalKey(approvalSymbolId(subdir, entry.symbol), ref);
      const used = taken.get(key) ?? 0;
      const approval = inForce.get(key)?.[used];
      if (approval) {
        taken.set(key, used + 1);
        approved.push({ entry, ref, approval });
      } else {
        unapproved.push({ entry, ref });
      }
    }
  }

  const unused = [...inForce.entries()]
    .flatMap(([key, bucket]) => bucket.slice(taken.get(key) ?? 0))
    .toSorted((a, b) => a.line - b.line);
  return { approved, unapproved, unused };
}
