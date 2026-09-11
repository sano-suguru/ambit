# ADR-0012: An unresolvable gain is reported, and gated only on request

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §6.4, the `unresolved` field in §5.1, and two rows
  of §6's exit-code table
- Evidence: [`docs/measurements/2026-09-11-third-party-diff-validation.md`](../measurements/2026-09-11-third-party-diff-validation.md)

## Context

Measured against `Unleash/unleash@044461b`, one change produced no line at all:
a symbol `unknown` on both sides gaining an operation no stub table names
(`axios`, `got`, `superagent`). A record carried a boolean, not the operations
behind it.

The near neighbour is not this case, and confusing the two would weaken a
working gate. A **known** effect added inside an `unknown` symbol already
fails — what is compared is head's effective effects minus base's, and
`unknown` beside them changes neither side. E4 in the measurement is the proof.

Saying nothing was ruled out by §3.4. What had to be decided is what the honest
signal *is*, because an unresolvable operation is not authority (§4.3) and so
cannot borrow §6.3's box: not its name, not its approval, not its exit code.

Noise was measured before the design, over three ranges of the subject's own
history: 1, 2 and 3 symbols for 3, 8 and 12 changed files, disjoint from what
`unknownGained` already names. It fires in proportion to the change, not to the
71% `unknown` surface.

## Decision

**Report it; fail on it only under `ambit diff --strict`.**

§5.1's authority record gains `unresolved`: the multiset, keyed by `(reason,
operation name)` with no position, of the operations in **this function's own
body** the analysis could not resolve. Empty for a `@boundary` function. It is
reported under its own heading, `ambit.approvals.md` is not involved, and
`--strict` fails on it together with `unknownGained`.

## Alternatives rejected

- **Failing by default.** Incoherent against §6's own table: `unknownGained` —
  a symbol the analysis used to reach and no longer does — exits 0. Failing on
  the lesser shape while the worse one passes is a classification wearing a
  rule's clothes.
- **A ledger line in `ambit.approvals.md`'s existing grammar.** The line names
  an *authority*. There is none here, so it would either name the operation in
  a field documented to hold authority or name nothing — and "a permission was
  approved" and "the analysis stopped reaching" become one string in one file,
  which is the confusion §6.3 exists to prevent (criterion 4).
- **A ledger line in a distinct grammar** (`unresolved:<operation>`). Rejected
  on the shape of the thing approved: most unresolved calls **have no name** —
  a callback parameter, an `any` receiver, `eval` — so the line would approve
  any count increase of anything nameless. Approving a count *delta* per line
  is the alternative, and no grammar for it reads correctly. §6.3's counting
  rule works because the pair it counts is a name; this pair is not.
- **Propagating the multiset**, as `unknown` itself propagates. Over-reports
  without adding information: a leaf's new `axios.get` would be named again on
  every caller, each already `unknown` before and after. The question is *where
  an operation was added*, which is body-local. A callee that newly makes its
  caller `unknown` still reaches the caller — as `unknownGained`.
- **Sets rather than multisets.** A function that gained a third opaque write
  would compare equal to itself: an unanalyzed addition read as nothing (§3.4).
  Keying on source position fails the other way — every line shift becomes a
  gain, and zero standing noise is gone on the first reformat.
- **A new diagnostic id.** ADR-0008's reason holds unchanged: `ambit diff`
  emits no `kind: "diagnostic"` record and has no `--format json`, so an id
  would name something that never appears in a diagnostic's `id` field.

## Consequences

- **`--strict` is usable only where its reports can be closed.** Of §4.3's
  three routes, a stub for a third-party package is Ambit's to write, not the
  adopter's — `ambit.config.ts` names symbols by `file#path` in the checked
  tree, not in `node_modules`. So a codebase calling `axios` has one exit under
  `--strict`, `@boundary` on the whole function, which says more than the
  change that triggered the report. Hence opt-in, and hence
  [`docs/limitations.md`](../limitations.md) rather than discovery.
- **`AuthorityRecord` now carries something that is not authority.** Justified
  here — `ambit diff` compares base and head records, so the comparable state
  has to travel with them — but the name no longer describes the contents. Not
  renamed: it is §9.2 surface and one field does not pay for the churn. Filed
  with its trigger in [`docs/open-questions.md`](../open-questions.md).
- **Zero standing noise survives**, which is what the whole gate rests on: an
  unmodified tree produces equal multisets and prints nothing, re-measured with
  the flag and without it. `--format github` stays silent without `--strict`,
  because a notice on every pull request touching an `unknown` function is how
  an annotation source gets muted — and it would cost the increases too.
- **It claims nothing about the operation.** The report says the verified
  extent got smaller and names what made it so; whether that matters is the
  reader's call, and Ambit has no basis for a stronger one (P4).

## Revisit when

- An adopter wants `--strict` and cannot close a report, because the operation
  is in a package no bundled table names — the pressure for either
  adopter-writable stubs or an isolation narrower than `@boundary`.
- The shape fires on substantially more than a handful of symbols per pull
  request in steady state (ADR-0008's trigger, for the same reason).
- `ambit diff` gains `--format json`, reopening the last rejection with
  ADR-0008's.
