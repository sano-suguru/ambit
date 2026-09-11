# ADR-0011: `ambit init` reports why it cannot propose a contract, and proposes no `@boundary`

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §4.1 "Adoption via `ambit init`"
- Evidence: [`docs/measurements/2026-09-11-coverage-and-latency.md`](../measurements/2026-09-11-coverage-and-latency.md),
  "How much of the `unknown` a reader can be told about"

## Context

§4.1 forbids `ambit init` from proposing anything for a function that reached
`unknown`: writing `@effects pure` on a function the analysis could not resolve
would turn "could not tell" into a guarantee. That prohibition is not in
question.

What was in question is everything it did not decide. Such a function got **no
output at all** — not the proposal it cannot have, and not the reason. The call
that stopped the inference, its position, and why it could not be followed are
all already in the summary the propagation ran over. Staying silent was not
caution; it was withholding evidence already collected. The measurement says the
withheld part is the majority: on every corpus target, more of the undeclared
`unknown` functions hold an unresolvable call in their own body than inherit
`unknown` from a callee.

## Decision

`ambit init` emits `AMB-I002` for an undeclared, non-`@boundary` function whose
propagated effects reached `unknown` **and** whose own calls hold a site that
leaves the caller incomplete. It lists those sites, each with its qualified name
where one exists, its position, and the route its reason implies. The exact
output is in [`docs/diagnostics/`](../diagnostics/README.md#amb-i002).

Three things it does not do:

- **It proposes no contract**, so `fixes` is empty. §5.3 defines `fixes[].edits`
  as concrete applicable patches, and every route here is either a decision only
  a person can make or work on Ambit itself.
- **It proposes no `@boundary`.**
- **It reports only the function that holds the call.** A caller that merely
  inherited `unknown` gets nothing: the leaf is already reported.

## Why no `@boundary` is proposed

§4.3 lists three ways to reduce `unknown` — declarations, stubs, and explicit
isolation via `boundary` — and then tallies the third **separately** from
succeeding at analysis, because a boundary excludes a body from checking rather
than resolving it.

A patch generating boundaries would be mechanical, and that is the problem:
`--coverage` would show the `unknown` rate falling after applying a fix Ambit
generated, while nothing about the code became more analyzable. Ambit would be
an advocate for its own primary KPI. Whether a body should be excluded from
analysis is a judgement about trust, and it is the reader's.

## Alternatives rejected

- **Propose `@boundary reason="<package>"` for a third-party call** — the
  paragraph above.
- **Extend the tag grammar so a partially known set can be declared**
  (`@effects network, unknown`). A declaration that shows its own hole is a
  change to the meaning of `@effects` — §9.2's guaranteed surface, and the whole
  propagation rule set. Nothing about reporting a reason requires it, and
  bundling the two would settle the larger question as a side effect of the
  smaller.
- **Keep the silence** — the status quo, rejected by the measurement. The
  information was already in hand when `init` chose to print nothing.

## Consequences

`AMB-I002` is a new diagnostic id, so it is a change to §9.2's guaranteed
surface and is announced in `CHANGELOG.md`. **It does not move the `unknown`
rate** and must not be read as progress on §4.3's KPI: nothing was resolved,
declared, or isolated — a reader was told what stands in the way.

A consumer filtering on `AMB-I001` to collect patches is unaffected:
`AMB-I002` never carries one.

The route text names what a reason *implies*, not what the reader should do, and
one route — `builtin-method` — names work on Ambit's own tables rather than on
the code being checked. That asymmetry is deliberate: a reader who cannot tell
the two apart will go looking for a mistake in their own code that is not there.

## Revisit when

- §4.2's tag grammar gains a spelling for a partially known effect set.
- `--coverage` starts reporting per-function reasons, making the same
  information available without running `init`.
