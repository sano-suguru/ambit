# ADR-0012: An unresolvable gain is reported, and gated only on request

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §6.4, the `unresolved` field in §5.1, and two rows
  of §6's exit-code table
- Evidence: [`docs/measurements/2026-09-11-third-party-diff-validation.md`](../measurements/2026-09-11-third-party-diff-validation.md)

## Context

On a third-party subject, one change produced no line at all: a symbol `unknown`
on both sides gaining an operation no stub table names. A record carried a
boolean, not the operations behind it, and §3.4 rules out saying nothing.

A **known** effect added inside an `unknown` symbol is not this case — it
already fails, because what is compared is the effective effect set. What had to
be decided is what the honest signal is, since an unresolvable operation is not
authority (§4.3) and so cannot borrow §6.3's name, approval, or exit code.
Noise was measured before the design: it scaled with the size of the change, not
with the standing `unknown` surface.

## Decision

**Report it; fail on it only under `ambit diff --strict`.**

§5.1's authority record gains `unresolved`: the multiset, keyed by `(reason,
operation name)` with no position, of the operations in **this function's own
body** the analysis could not resolve. Empty for a `@boundary` function. It is
reported under its own heading, `ambit.approvals.md` is not involved, and
`--strict` fails on it together with `unknownGained`.

## Alternatives rejected

- **Failing by default.** `unknownGained` — a symbol the analysis no longer
  reaches — exits 0. Failing on the lesser shape while the worse one passes is a
  classification, not a rule.
- **A ledger line in the existing grammar.** The line names an authority; there
  is none here, and "a permission was approved" and "the analysis stopped
  reaching" would become one string (§6.3's criterion 4).
- **A ledger line in a distinct grammar** (`unresolved:<operation>`). Most
  unresolved calls have no name, so a line would approve any count increase of
  anything nameless.
- **Propagating the multiset**, as `unknown` propagates. A leaf's new operation
  would be named again on every caller, each already `unknown`. The question is
  where an operation was added, which is body-local; a callee newly making its
  caller `unknown` still reaches it as `unknownGained`.
- **Sets rather than multisets**, or keys holding a position. The first reads a
  third opaque write as nothing; the second turns every line shift into a gain.
- **A new diagnostic id.** ADR-0008's reason holds: `ambit diff` emits no
  diagnostic records.

## Consequences

- **`--strict` is usable only where its reports can be closed.** A stub for a
  third-party package is Ambit's to write, not the adopter's, so a codebase
  calling an uncovered client may have only `@boundary` on the whole function.
  Hence opt-in, and hence [`docs/limitations.md`](../limitations.md).
- **The authority record now carries something that is not authority.** Not
  renamed — it is §9.2 surface, and one field does not pay for the churn. The
  trigger is in [`docs/open-questions.md`](../open-questions.md).
- **Zero standing noise survives**: an unmodified tree prints nothing, with the
  flag and without it. `--format github` stays silent without `--strict`, so the
  annotation source is not muted.
- **It claims nothing about the operation** (P4).

## Revisit when

- An adopter wants `--strict` and cannot close a report, because the operation
  is in a package no bundled table names.
- The shape fires on more than a handful of symbols per pull request in steady
  state.
- `ambit diff` gains `--format json`.
