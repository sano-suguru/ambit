# ADR-0008: An authority increase is approved by a ledger line that is valid only in the comparison that adds it

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §6.3, and the exit-code table in §6
- Evidence: measured in `docs/status.md`, "Promoting `ambit diff` to a gate"

## Context

`ambit diff` detects that a tree's authority grew (§6). It could not be made a
CI gate, because a pull request that legitimately adds authority had no way to
say so: the gate would either block every honest change or be routinely
overridden. `docs/DESIGN.md` §12 listed three candidates — an allowlist, a
pinned baseline, and "this increase is approved" — and picked none.

The criteria the answer had to meet were set first, and are recorded in §6.3.
Restated here, because every alternative below is rejected against them:

1. The approval is a reviewable record **in the repository**. Ambit's claim is
   that a human reviews an increase; a mechanism whose record lives in a CI
   provider's state (a label, a re-run button, an environment approval) leaves
   nothing in the tree and does not support the claim.
2. An approval that has gone stale must not silently let an increase through.
3. Increases that are artifacts of moving or renaming code must not be a
   standing tax on the mechanism. An approval file rewritten by every
   refactoring PR is a ritual, and a ritual is not review.
4. It must not enlarge the apparent guarantee surface (§2, P4). That an increase
   *can* be approved says nothing about whether the approver was right.

## Decision

**"This increase is approved", with the ledger itself diffed.**

`ambit.approvals.md` holds one line per approved `(symbol id, authority)`. The
file is read on both sides of the comparison, and the approvals in force for a
pair are the head side's count of that pair minus the base side's. A line
already present in the base grants nothing.

Separately, and before approvals are consulted, symbols are carried across file
renames that **git itself** reports, so a move is compared against itself rather
than read as a deletion plus a new symbol.

## Alternatives considered

- **(A) Allowlist** — a standing list of `(symbol, authority)` pairs permitted
  to exist. Fails criterion 2 outright: the entry never expires, so authority
  removed and later reintroduced passes silently years later. It also duplicates
  the contract. An entry reading "`priceOrder` may use `network`" is an
  `@effects` declaration written in a second place and checked by nothing —
  two sources of truth for the same fact, which §4.1 exists to avoid.
- **(B) Pinned baseline** — a generated snapshot of the whole authority surface,
  regenerated to approve. Meets criteria 1 and 2, and fails 3 hardest of the
  three: the snapshot is keyed by symbol id, symbol ids contain paths, and every
  file move rewrites a large block of it. Approving then means running
  `--update` and committing whatever came out, which is a diff no reviewer reads
  line by line — the mechanism produces a record and destroys the reviewing of
  it at the same time. It also moves the question "did authority grow?" from the
  base ref onto a file's freshness.
- **(C) The chosen design, but with approvals keyed by presence rather than
  count.** Rejected on criterion 3. Under presence semantics an increase that is
  added, later removed, and legitimately re-added cannot be approved at all: the
  old line is in the base, so a fresh line is not new. The way out is to delete
  the line in one pull request and re-add it in the next, which is exactly the
  two-step ritual criterion 3 forbids. Counting makes re-approval an append and
  leaves the ledger append-only.
- **(D) Matching moved functions by authority equality rather than by git's
  rename report.** Rejected as under-reporting. A pull request that deletes
  `a.ts#f` (holding `network`) and separately adds an unrelated `b.ts#g`
  (holding `network`) would have `g` excused by `f`'s deletion. Git's similarity
  index is evidence about the file; authority equality is a coincidence.

## Consequences

- **Approval is transient by construction, and that is the point.** After the
  pull request merges, the base holds the authority, so there is no increase to
  approve and the line is spent. Nothing has to remember to revoke it.
- **The ledger grows.** Old lines are inert history. Deleting them is safe —
  removing a line can only lower a head-side count, never raise it — but it is
  never required, so the file is never a source of merge conflicts beyond the
  append point.
- **Per-symbol granularity has a price, and it is paid in lines.** Every new
  function that performs I/O is a new symbol holding authority, and costs one
  line. This change needed five for its own source (`docs/status.md`). The
  alternative — approving per file, or per authority across the tree — would
  make one line cover increases nobody looked at, which is criterion 4 in the
  other direction.
- **Ambit does not verify that a human wrote the line.** An agent can write one
  as easily as a person. What the design supplies is the record and its
  visibility in the diff; what supplies the human is branch protection and a
  `CODEOWNERS` entry on the file. §6.3 says so rather than leaving it implied.
- **Two rename cases remain uncovered** — a function renamed within a file, and
  a move git's similarity threshold does not detect. Both over-report, each
  costing one line.
- **No new diagnostic code.** `ambit diff` emits no `kind: "diagnostic"` records
  and has no `--format json`; an id in `docs/diagnostics/` that never appears in
  a diagnostic's `id` field would misdescribe the ledger there.

## Revisit when

- `ambit diff` gains `--format json`, at which point the approval outcomes need
  diagnostic ids rather than command-level text.
- A repository is observed appending more than a handful of approval lines per
  pull request in steady state.
- Git rename detection is observed missing a move that the reviewer considered
  obvious.
