# ADR-0011: `ambit init` reports why it cannot propose a contract, and proposes no `@boundary`

- Status: Accepted (2026-09-11)
- Decides: `docs/DESIGN.md` §4.1 "Adoption via `ambit init`", and `AMB-I002` in `docs/diagnostics/`
- Evidence: `docs/status.md` — "How much of the `unknown` a reader can be told about"

## Context

§4.1 forbids `ambit init` from proposing anything for a function that reached
`unknown`: writing `@effects pure` on a function the analysis could not resolve
would turn "could not tell" into a guarantee. That prohibition is not in
question here.

What was in question is everything the prohibition did not decide. A function
that reached `unknown` got **no output at all** — not the proposal it cannot
have, and not the reason it cannot have one. The call that stopped the
inference, its position, and why it could not be followed are all already in
the summary the propagation ran over. Staying silent about them was not caution;
it was withholding evidence that had already been collected.

The measurement says the withheld part is the majority: on every corpus target,
more of the functions that are undeclared and `unknown` hold an unresolvable
call in their own body than inherit `unknown` from a callee.

## Decision

`ambit init` emits `AMB-I002` for an undeclared, non-`@boundary` function whose
propagated effects reached `unknown` **and** whose own `calls` hold a site that
leaves the caller incomplete. It lists those sites, each with its qualified name
where one exists, its position, and the route its reason implies.

Three things it does not do.

**It proposes no contract**, so `fixes` is empty. §5.3 defines `fixes[].edits`
as concrete applicable patches. Every route here is either a decision only a
person can make or work on Ambit itself; a candidate that only describes what to
do is the summary-only candidate §5.3 forbids.

**It proposes no `@boundary`.** §4.3 lists three ways to reduce `unknown` —
declarations, stubs, and explicit isolation via `boundary` — and then tallies
the third separately from succeeding at analysis, because moving code behind a
boundary excludes its body from checking rather than resolving it. A tool that
suggested the boundary would be a tool suggesting how to move its own primary
KPI. Where a route names `@boundary` as the alternative to a stub, it names it
with that accounting attached, as §4.3 states it.

**It reports only the function that holds the call.** A caller that merely
inherited `unknown` gets nothing: the leaf is already reported, and repeating it
once per caller is volume, not information.

## Alternatives considered

1. **Report the blocking calls, with no fix and no boundary proposal** (adopted).
2. Propose `@boundary reason="<package>"` as a fix for a third-party call.
3. Extend the tag grammar so a partially known set can be declared
   (`@effects network, unknown`).
4. Keep the silence.

## Reasons

**2 makes Ambit an advocate for its own number.** The patch would be
mechanical, and that is the problem: `--coverage` would show the `unknown` rate
falling after applying a fix Ambit generated, while nothing about the code
became more analyzable. §4.3 separates the two tallies precisely so that the
distinction survives; generating the boundary would erase it from the side that
is supposed to be keeping it honest. Whether a body should be excluded from
analysis is a judgement about trust, and it is the reader's.

**3 is a different decision from this one.** A declaration that shows its own
hole is a change to the meaning of `@effects` — §9.2's guaranteed surface, and
the whole propagation rule set that reads the tag. Nothing about reporting a
reason requires it, and bundling the two would settle the larger question as a
side effect of the smaller.

**4 was the status quo, and the measurement is what rejected it.** The
information was already in hand at the moment `init` chose to print nothing.

## Consequences

`AMB-I002` is a new diagnostic id, so it is a change to §9.2's guaranteed
surface and is announced in `CHANGELOG.md`. It does not move the `unknown`
rate, and must not be read as progress on §4.3's KPI: nothing was resolved,
declared, or isolated — a reader was told what stands in the way.

`ambit init` now emits two info ids. A consumer filtering on `AMB-I001` to
collect patches is unaffected: `AMB-I002` never carries one.

The route text names what a reason implies, not what the reader should do about
it, and one route — `builtin-method` — names work on Ambit's own bundled
tables rather than on the code being checked. That asymmetry is deliberate: a
reader who cannot tell the two apart will go looking for a mistake in their own
code that is not there.

## Revisit when

- §4.2's tag grammar gains a spelling for a partially known effect set
- `--coverage` starts reporting per-function reasons, making the same
  information available without running `init`
