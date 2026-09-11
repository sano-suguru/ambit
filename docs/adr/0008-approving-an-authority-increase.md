# ADR-0008: Authority approvals are comparison-scoped

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §6.3, and the exit-code table in §6
- Evidence: [`docs/measurements/2026-09-11-coverage-and-latency.md`](../measurements/2026-09-11-coverage-and-latency.md),
  "Promoting `ambit diff` to a gate"

## Context

`ambit diff` detects that a tree's authority grew (§6). It could not be made a
CI gate, because a pull request that legitimately adds authority had no way to
say so: the gate would either block every honest change or be routinely
overridden.

The criteria the answer had to meet were set first and are recorded in §6.3, so
that a later reconsideration has something in the specification to test itself
against. Restated, because every alternative below is rejected against them:
(1) the approval is a reviewable record **in the repository**; (2) a stale
approval must not silently let an increase through; (3) moving and renaming code
must not be a standing tax; (4) the apparent guarantee surface must not grow
(P4).

## Decision

**An approval is valid only in the comparison that adds it.**

`ambit.approvals.md` holds one line per approved `(symbol id, authority)`. The
file is read on *both* sides of the comparison, and the approvals in force for a
pair are the head side's count of that pair minus the base side's. A line
already present in the base grants nothing, forever.

Separately, and before approvals are consulted, symbols are carried across file
renames that **git itself** reports, so a move is compared against itself rather
than read as a deletion plus a new symbol.

## Alternatives rejected

- **A standing allowlist** of `(symbol, authority)` pairs permitted to exist.
  Fails criterion 2 outright: the entry never expires, so authority removed and
  later reintroduced passes silently years later. It also duplicates the
  contract — "`priceOrder` may use `network`" is an `@effects` declaration
  written in a second place and checked by nothing.
- **A pinned baseline** — a generated snapshot of the whole authority surface,
  regenerated to approve. Fails criterion 3 hardest: symbol ids contain paths,
  so every file move rewrites a large block, and approving means committing
  whatever `--update` produced. The mechanism produces a record and destroys the
  reviewing of it at the same time.
- **The same design keyed by presence rather than count.** Fails criterion 3: an
  increase added, removed, and legitimately re-added cannot be approved, because
  the old line is in the base. The way out is deleting the line in one pull
  request and re-adding it in the next — the two-step ritual criterion 3 forbids.
  Counting makes re-approval an append and leaves the ledger append-only.
- **Matching moved functions by authority equality** rather than by git's rename
  report. Under-reports: a pull request deleting `a.ts#f` (holding `network`)
  and separately adding an unrelated `b.ts#g` (holding `network`) would have `g`
  excused by `f`'s deletion. Git's similarity index is evidence about the file;
  authority equality is a coincidence.

## Consequences

- **Approval is transient by construction, and that is the point.** After the
  merge the base holds the authority, so there is no increase to approve and the
  line is spent. Nothing has to remember to revoke it.
- **Per-symbol granularity is paid in lines.** Every new function that performs
  I/O is a new symbol holding authority. This change needed five for its own
  source. Approving per file, or per authority across the tree, would make one
  line cover increases nobody looked at — criterion 4 in the other direction.
- **Ambit does not verify that a human wrote the line.** An agent can write one
  as easily as a person. What the design supplies is the record and its
  visibility in the diff; what supplies the human is branch protection and a
  `CODEOWNERS` entry on the file. §6.3 and `docs/limitations.md` both say so
  rather than leaving it implied.
- **Two rename cases remain uncovered** — a function renamed within a file, and
  a move git's similarity threshold does not detect. Both over-report.
- **No new diagnostic code.** `ambit diff` emits no `kind: "diagnostic"` records
  and has no `--format json`; an id that never appears in a diagnostic's `id`
  field would misdescribe the ledger.

## Revisit when

- `ambit diff` gains `--format json`, at which point approval outcomes need
  diagnostic ids rather than command-level text.
- A repository is observed appending more than a handful of approval lines per
  pull request in steady state.
- Git rename detection is observed missing a move the reviewer considered
  obvious.
