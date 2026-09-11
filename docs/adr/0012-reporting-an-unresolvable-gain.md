# ADR-0012: An unresolvable gain is reported, and gated only on request

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §6.4, the `unresolved` field in §5.1, and two rows
  of §6's exit-code table
- Evidence: [`docs/measurements/2026-09-11-third-party-diff-validation.md`](../measurements/2026-09-11-third-party-diff-validation.md),
  "A gain the analysis cannot resolve has no line", and the follow-up run at the
  end of that file

## Context

`ambit diff` compares effective authority (§6.3, [ADR-0008](0008-approving-an-authority-increase.md)).
Measured against `Unleash/unleash@044461b`, one kind of change produced no line
at all: a symbol that is `unknown` on both sides gaining an operation no stub
table names. `axios` and `got` are the concrete cases — outbound HTTP that
Ambit cannot see, added to a function Ambit already could not see through.

The near neighbour is *not* this case, and confusing the two would weaken a
working gate. A **known** effect added inside an `unknown` symbol already fails:
what is compared is head's effective effects minus base's, and `unknown`
standing beside them changes neither side. E4 in the measurement is the proof —
a `del()` added to `TagStore.getAll`, `unknown` before and after, exits 1.

So the gap is narrow: the *unresolvable* gain. It has two shapes, and only the
first had a line. Base resolved → head `unknown` is `unknownGained`, printed,
exit 0. Base `unknown` → head `unknown` with more unresolvable operations inside
it was nothing at all, because a record carried a boolean and not the operations
behind it.

Saying nothing was already ruled out by §3.4. What had to be decided was what
the honest signal *is*, because an unresolvable operation is not authority
(§4.3) and therefore cannot borrow §6.3's box: not its name, not its approval
form, not its exit code.

The noise was measured before the design, over three ranges of the subject's own
history: 1, 2 and 3 symbols for 3, 8 and 12 changed files, disjoint on
`HEAD~20..HEAD` from the three `unknownGained` already names. It fires in
proportion to the change, not to the 71% `unknown` surface.

## Decision

**Report both shapes; fail on neither by default; fail on both under
`ambit diff --strict`.**

Three parts, each load-bearing:

1. **A record carries what it could not resolve.** §5.1's authority record gains
   `unresolved`: the multiset, keyed by `(reason, operation name)`, of the
   operations in **this function's own body** that the analysis could not
   resolve. Body-local, not propagated. Empty for a `@boundary` function.
2. **It is not an authority increase and has no approval line.** It is reported
   under its own heading, in its own words, and `ambit.approvals.md` is not
   involved.
3. **The exit code is opt-in, and covers both shapes together.**

## Alternatives rejected

- **Failing by default.** Incoherent against §6's own table. Shape 1 — a symbol
  the analysis used to reach and no longer does — exits 0. A default that failed
  on shape 2 while shape 1 passed would be a classification wearing a rule's
  clothes. Lowering shape 1 to match would also have to be argued, and the
  argument is the same one this ADR makes for opt-in.
- **A ledger line in `ambit.approvals.md`, in the existing grammar.** Fails
  criterion 4 of §6.3 in the direction that matters: the line
  `` - `src/x.ts#f` `effect:network` — reason `` records that a *named*
  authority was granted. There is no authority here to name, so the line would
  either name the operation in a field documented to hold authority, or name
  nothing. Either way "a permission was approved" and "the analysis stopped
  reaching" become the same string in the same file, which is the confusion the
  whole section exists to prevent.
- **A ledger line in a distinct grammar** (`unresolved:<operation>`). Rejected on
  the shape of the thing being approved rather than on taste. The multiset's key
  is `(reason, name)` and a great many unresolved calls **have no name** — a
  callback parameter, an `any` receiver, `eval`. A line spelling
  `unresolved:unresolved-symbol` would approve any count increase of anything
  nameless in that symbol, forever within its comparison. Approving a *count
  delta* per line is the alternative, and there is no grammar for it that a
  reviewer reads correctly. §6.3's counting rule works because the pair it counts
  is a name; this pair is not.
- **Propagating the multiset up the call graph**, as `unknown` itself
  propagates. Over-reports without adding information: a leaf that gained an
  `axios.get` would name it again on every caller, and the caller was already
  `unknown` before and after. The question shape 2 answers is *where an
  operation was added*, which is a body-local question. A callee that newly
  makes its caller `unknown` still reaches the caller — as shape 1.
- **Comparing sets rather than multisets.** A function that gained a third
  opaque write would compare equal to itself. That is reading an unanalyzed
  addition as nothing, which is non-negotiable §3.4 again.
- **Keying on source position.** Every line shift becomes a gain, and the
  standing-noise-zero property that makes the gate worth having is gone on the
  first reformat.
- **A new diagnostic id.** ADR-0008's reason still holds unchanged: `ambit diff`
  emits no `kind: "diagnostic"` record and has no `--format json`, so an id in
  [`docs/diagnostics/`](../diagnostics/README.md) would name something that never
  appears in a diagnostic's `id` field. The ledger is not extended.

## Consequences

- **`diff --strict` is usable only where the report can be closed.** §4.3's three
  routes are a verifiable declaration, a stub, or `@boundary`. Of those, a stub
  for a third-party package is Ambit's to write, not the adopter's:
  `ambit.config.ts` names symbols by `file#path` in the checked tree, not symbols
  in `node_modules`. So an adopter using `axios` today has exactly one exit under
  `--strict` — `@boundary` on the whole function — which is a larger statement
  than the change that triggered the report. This is why the flag is opt-in and
  not the default, and it is stated in
  [`docs/limitations.md`](../limitations.md) rather than left to be discovered.
- **The default output grows by one section, and only when it is non-empty.** An
  unmodified tree produces identical records on both sides, so the multisets are
  equal and nothing is printed. The zero-standing-noise property §6 depends on is
  unchanged, and was re-measured.
- **`--format github` is unchanged by default.** The two shapes annotate only
  under `--strict`, as errors. A notice on every pull request that touched an
  `unknown` function would be the noise that gets an annotation source muted.
- **The NDJSON record is one field wider**, and `--format json` consumers see it
  (§9.2, announced in `CHANGELOG.md`).
- **`unknown` is still not authority anywhere.** Nothing here is counted in
  `added`, in an approval, or in the `--coverage` rate. The report says the
  verified extent got smaller and names the operation; it does not say the
  operation is dangerous, and Ambit has no basis to (P4).

## Revisit when

- An adopter wants `diff --strict` and cannot close a report, because the
  operation is in a package no bundled table names. That is the pressure for
  either adopter-writable stubs or a narrower isolation than `@boundary`.
- The second shape is observed firing on substantially more than a handful of
  symbols per pull request in steady state — the same trigger ADR-0008 records
  for approval lines.
- `ambit diff` gains `--format json`, at which point the report needs an id and
  this ADR's last rejection is reopened with ADR-0008's.
