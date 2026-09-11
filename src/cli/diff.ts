import path from "node:path";
import type {
  ApprovalReview,
  AuthorityDiff,
  AuthorityRef,
  IncreaseItem,
  MalformedApprovalLine,
} from "../core/index.ts";
import {
  authorityDecreases,
  deletedSymbols,
  diffAuthority,
  displayName,
  formatApprovalLine,
  formatUnresolvedOperation,
  hasUnresolvedWidening,
  movedSymbols,
  pathFor,
  reviewIncreases,
  unchangedSymbols,
  unknownGained,
  unresolvedGains,
} from "../core/index.ts";
import { analyze } from "./analyze.ts";
import { loadApprovals } from "./approvals.ts";
import { githubAnnotation, workspacePath } from "./github.ts";
import { addWorktree, git, removeWorktree, renamedFiles, repositoryRoot } from "./worktree.ts";

/** What `ambit diff` compared, and what came out. */
export interface DiffResult {
  readonly diff: AuthorityDiff;
  /**
   * Which increases the approval ledger lets through, which it does not, and
   * which lines granted nothing (DESIGN.md §6.3).
   */
  readonly review: ApprovalReview;
  /** `-` lines in the head side's ledger that did not parse. Reported; they grant nothing. */
  readonly malformedApprovals: readonly MalformedApprovalLine[];
  /** The ledger that governed the head side, relative to the checked directory's repository. */
  readonly approvalsFile?: string;
  /** The ref as given, and the commit it resolved to — a branch name moves, a sha does not. */
  readonly ref: string;
  readonly baseCommit: string;
  /** The directory that was compared, relative to the repository root. */
  readonly subdir: string;
  /** That same directory as the caller gave it — what a `location.file` is relative to. */
  readonly dir: string;
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

  // Asked of the working tree, before the base checkout exists: `git diff`
  // compares the index and the working tree against `baseCommit`, and the
  // temporary worktree is neither.
  const renames = await renamedFiles(repoRoot, baseCommit, subdir);

  const worktree = await addWorktree(repoRoot, baseCommit, subdir);
  try {
    // The same subpath on both sides: a symbol id is relative to the
    // directory that was checked (DESIGN.md §5.3), so comparing `src` against
    // a whole repository would make every id look new.
    const baseDir = path.join(worktree.root, subdir);
    const headDir = path.resolve(dir);
    const base = await analyze(baseDir);
    const head = await analyze(headDir);
    // The ledger is read on both sides, because an approval counts only in
    // the comparison that adds it (DESIGN.md §6.3).
    const baseApprovals = loadApprovals(baseDir);
    const headApprovals = loadApprovals(headDir);

    const diff = diffAuthority(base.authority, head.authority, renames);
    return {
      diff,
      review: reviewIncreases(diff, baseApprovals.parsed.approvals, headApprovals.parsed.approvals),
      malformedApprovals: headApprovals.parsed.malformed,
      ...(headApprovals.filePath
        ? { approvalsFile: path.relative(repoRoot, headApprovals.filePath) }
        : {}),
      ref,
      baseCommit,
      subdir,
      dir: headDir,
    };
  } finally {
    await removeWorktree(worktree);
  }
}

/** Whether the comparison fails: an increase with no approval in force (DESIGN.md §6.3). */
export function hasUnapprovedIncrease(result: DiffResult): boolean {
  return result.review.unapproved.length > 0;
}

/**
 * How the comparison was invoked, for the parts of the output that depend on
 * it rather than on what was compared.
 *
 * Only `--strict` is here, and only because §6.4's two shapes are reported
 * either way and fail only under it: the reader has to be told which of the
 * two runs they are looking at, or a green exit reads as "nothing to see".
 */
export interface DiffOptions {
  readonly strict?: boolean;
}

/**
 * Whether `--strict` fails this comparison: the analysis stopped reaching a
 * symbol, or a symbol's body gained an operation it cannot resolve
 * (DESIGN.md §6.4). Always `false` without the flag — both shapes are reported
 * at exit 0 by default.
 */
export function failsStrict(result: DiffResult, options: DiffOptions = {}): boolean {
  return options.strict === true && hasUnresolvedWidening(result.diff);
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
export function formatDiffText(result: DiffResult, options: DiffOptions = {}): string {
  const { diff, review } = result;
  const decreases = authorityDecreases(diff);
  const deleted = deletedSymbols(diff);
  const moved = movedSymbols(diff);
  const unknown = unknownGained(diff);
  const unresolved = unresolvedGains(diff);
  const strict = options.strict === true;
  const where = result.subdir === "" ? "the repository root" : result.subdir;

  const lines: string[] = [
    `base ${result.ref} (${result.baseCommit.slice(0, 7)}) vs the working tree, over ${where}`,
    "",
  ];

  if (review.unapproved.length === 0 && review.approved.length === 0) {
    lines.push("No authority increased.", "");
  }

  if (review.unapproved.length > 0) {
    lines.push(
      `${count(review.unapproved.length, "authority")} increased without approval:`,
      "",
      ...review.unapproved.flatMap((item) => renderIncrease(item)),
      `Add each line above to ${result.approvalsFile ?? APPROVALS_HINT}, with the reason, and`,
      "commit it in the same change (DESIGN.md §6.3). An approval already in the base",
      "grants nothing.",
      "",
    );
  }

  // Approved increases are still printed in full. The point of the ledger is
  // that an increase is visible to whoever reads the pull request, and a
  // section that collapses to a count would undo exactly that.
  if (review.approved.length > 0) {
    lines.push(
      `${count(review.approved.length, "authority")} increased, approved in this change:`,
      "",
      ...review.approved.flatMap((item) => [
        ...renderIncrease(item, { suggestApproval: false }),
        `      approved: ${item.approval.reason} (${result.approvalsFile ?? APPROVALS_HINT}:${item.approval.line})`,
        "",
      ]),
    );
  }

  if (review.unused.length > 0) {
    lines.push(
      `${count(review.unused.length, "approval")} added here matched no increase and granted nothing:`,
      ...review.unused.map(
        (approval) =>
          `  ${result.approvalsFile ?? APPROVALS_HINT}:${approval.line}  ${approval.symbol} ${approval.authority.kind}:${approval.authority.name}`,
      ),
      "",
    );
  }

  if (result.malformedApprovals.length > 0) {
    lines.push(
      `${count(result.malformedApprovals.length, "line")} in ${result.approvalsFile ?? APPROVALS_HINT} did not parse as an approval and granted nothing:`,
      ...result.malformedApprovals.map((entry) => `  line ${entry.line}: ${entry.text}`),
      "",
    );
  }

  if (moved.length > 0) {
    lines.push(
      `${count(moved.length, "symbol")} moved with a renamed file and was compared against its old path:`,
      ...moved.map((entry) => `  ${entry.movedFrom} -> ${entry.symbol}`),
      "",
    );
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

  // §6.4's second shape. The symbol was already unresolved, so nothing about
  // it "increased" — what changed is that there is now more of it the analysis
  // did not read, and the operations that made it so are named.
  if (unresolved.length > 0) {
    lines.push(
      `${count(unresolved.length, "symbol")} gained an operation the analysis could not resolve:`,
      "",
      ...unresolved.flatMap((entry) => [
        `  ${entry.symbol}${entry.head ? ` (${entry.head.location.file}:${entry.head.location.line})` : ""}`,
        ...entry.unresolvedGained.map(
          (operation) => `    ? ${formatUnresolvedOperation(operation)}`,
        ),
      ]),
      "",
      "This is not authority (DESIGN.md §4.3), so no approval covers it and none is",
      "asked for. What closes it is a stub, a verifiable declaration, or explicit",
      "isolation behind @boundary (§4.3, §6.4).",
      "",
    );
  }

  if (strict && (unknown.length > 0 || unresolved.length > 0)) {
    // Named for what is actually above it. Only one of §6.4's two shapes
    // firing is the common case, and "the two sections above" would send the
    // reader looking for a section that is not there.
    const sections = unknown.length > 0 && unresolved.length > 0 ? "two sections" : "section";
    lines.push(
      `--strict: the ${sections} above ${sections === "section" ? "fails" : "fail"} this comparison (DESIGN.md §6.4).`,
      "Without --strict they are reported and the comparison passes.",
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

/** Where to write an approval when the repository has no ledger yet (DESIGN.md §6.3). */
const APPROVALS_HINT = "ambit.approvals.md";

/**
 * One authority one symbol gained: the symbol at its own position, the
 * authority, and the path that carries it.
 *
 * A path is shown only where the record has one. An authority a function
 * declares but does not reach has no path, and none is invented
 * (DESIGN.md §5.3).
 *
 * For an increase with nothing approving it, the ledger line to add follows,
 * ready to copy — the grammar of §6.3 is a thing to paste, not to recall.
 */
function renderIncrease(
  item: IncreaseItem,
  options: { readonly suggestApproval?: boolean } = {},
): readonly string[] {
  const { entry, ref } = item;
  const at = entry.head ? ` (${entry.head.location.file}:${entry.head.location.line})` : "";
  const what =
    entry.status === "new" ? "  [new symbol]" : entry.status === "moved" ? "  [moved]" : "";
  const lines = [`  ${entry.symbol}${at}${what}`, `    + ${refText(ref)}`];

  const path = pathFor(entry.head, ref);
  for (const hop of path?.via ?? []) {
    lines.push(`      -> ${displayName(hop.symbol)} (${hop.file}:${hop.line})`);
  }
  if (path?.operation) {
    lines.push(
      `      operation: ${path.operation.qualifiedName} (${path.operation.file}:${path.operation.line})`,
    );
  }
  if (options.suggestApproval !== false) {
    lines.push(`    ${formatApprovalLine(entry.symbol, ref)}`, "");
  }
  return lines;
}

/**
 * An authority as a reader recognizes it: an effect by its bare name, a
 * capability prefixed so the two lattices never read as one namespace.
 */
function refText(ref: AuthorityRef): string {
  return ref.kind === "effect" ? ref.name : `capability ${ref.name}`;
}

/**
 * `1 symbol` / `2 symbols`, with the plural spelled out where appending an
 * `s` gets it wrong — "2 authoritys" is the sort of thing a reader stops on.
 */
const PLURALS: Readonly<Record<string, string>> = { authority: "authorities" };

function count(n: number, noun: string): string {
  if (n === 1) return `${n} ${noun}`;
  return `${n} ${PLURALS[noun] ?? `${noun}s`}`;
}

/**
 * One GitHub Actions annotation per authority gained — per symbol *and*
 * authority, since that is what a reviewer acts on: `priceOrder` gaining
 * `network` and `fs_write` are two decisions, not one.
 *
 * Annotated at the symbol's own declaration, with the call path folded into
 * the body, so the annotation lands on the function whose contract changed
 * and carries the reason without the reader opening the job log — the same
 * shape `check --format github` uses (DESIGN.md §5.1 / §6).
 *
 * An unapproved increase is an `error`, and carries the ledger line to add.
 * An **approved** one is a `notice`, carrying the reason that was given: it
 * does not fail the build, and it must still be visible on the diff, because
 * an increase nobody sees is the thing the ledger exists to prevent (§6.3).
 * A decrease and a deletion are reported by the text output and do not fail a
 * build (§6), so an annotation on them would be noise on a diff.
 */
export function formatDiffGithub(result: DiffResult, options: DiffOptions = {}): string {
  let out = "";
  for (const item of result.review.unapproved) {
    out += increaseAnnotation(result, item, "error", [
      `add to ${result.approvalsFile ?? APPROVALS_HINT}: ${formatApprovalLine(item.entry.symbol, item.ref)}`,
    ]);
  }
  for (const item of result.review.approved) {
    out += increaseAnnotation(result, item, "notice", [
      `approved in this change: ${item.approval.reason}`,
    ]);
  }
  if (options.strict === true) out += wideningAnnotations(result);
  return out;
}

/**
 * §6.4's two shapes as annotations, under `--strict` only.
 *
 * Withheld without the flag deliberately, and the default output is
 * byte-identical to what it was before §6.4 existed. Both shapes are common on
 * a codebase that declares nothing, and a `notice` on every pull request that
 * touched an `unknown` function is how an annotation source gets muted — which
 * would cost the increases too, since they share the channel. A repository that
 * wants the signal asks for it, and then it is an `error`, because under
 * `--strict` that is what it is.
 */
function wideningAnnotations(result: DiffResult): string {
  let out = "";
  for (const entry of unknownGained(result.diff)) {
    const head = entry.head;
    if (!head) continue;
    out += githubAnnotation({
      severity: "error",
      file: workspacePath(result.dir, head.location.file),
      line: head.location.line,
      col: head.location.col,
      title: "ambit diff",
      body: [
        `${displayName(head.symbol)} is no longer resolved by the analysis since ${result.ref}`,
        "this is not authority (DESIGN.md §4.3); --strict fails on it (§6.4)",
      ],
    });
  }
  for (const entry of unresolvedGains(result.diff)) {
    const head = entry.head;
    if (!head) continue;
    out += githubAnnotation({
      severity: "error",
      file: workspacePath(result.dir, head.location.file),
      line: head.location.line,
      col: head.location.col,
      title: "ambit diff",
      body: [
        `${displayName(head.symbol)} gained ${count(entry.unresolvedGained.length, "operation")} the analysis could not resolve since ${result.ref}`,
        ...entry.unresolvedGained.map((operation) => `? ${formatUnresolvedOperation(operation)}`),
        "a stub, a verifiable declaration, or @boundary closes it (§4.3, §6.4)",
      ],
    });
  }
  return out;
}

function increaseAnnotation(
  result: DiffResult,
  item: IncreaseItem,
  severity: string,
  trailer: readonly string[],
): string {
  const head = item.entry.head;
  if (!head) return "";
  const path = pathFor(head, item.ref);
  const what =
    item.entry.status === "new"
      ? "new symbol"
      : item.entry.status === "moved"
        ? "moved, and widened"
        : "authority increased";
  return githubAnnotation({
    severity,
    file: workspacePath(result.dir, head.location.file),
    line: head.location.line,
    col: head.location.col,
    title: "ambit diff",
    body: [
      `${displayName(head.symbol)} gained ${refText(item.ref)} since ${result.ref} (${what})`,
      ...(path?.via ?? []).map((hop) => `-> ${displayName(hop.symbol)} (${hop.file}:${hop.line})`),
      ...(path?.operation
        ? [
            `operation: ${path.operation.qualifiedName} (${path.operation.file}:${path.operation.line})`,
          ]
        : []),
      ...trailer,
    ],
  });
}
