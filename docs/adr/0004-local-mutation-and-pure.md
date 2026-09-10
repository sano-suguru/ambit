# ADR-0004: `pure` permits mutation of values created inside the function

- Status: Accepted (2026-09-09)
- Decides: `docs/DESIGN.md` §4.2 "Local mutation and `pure`"
- Evidence: `docs/status.md` — the before/after `unknown` measurement

## Context

`Array.push` onto a locally created array is the ordinary way to write a pure
function in TypeScript. Whether that counts as an effect decides what `pure` can
mean, and — because a mutation whose effect is undetermined falls to `unknown` —
what the primary KPI measures.

## Decision

`pure` permits mutation of values created inside the function. Only mutation of a
value reachable from outside the function is `state_write`, and if it exceeds the
declaration it becomes a violation under propagation rule 1.

## Alternatives considered

1. **Permit local mutation, and count only externally reachable mutation as an
   effect** (adopted).
2. Report every mutation as an effect. `pure` would not even permit a `push` onto
   a `const out: T[] = []`.
3. Leave mutation outside the effect model. A destructive method would fall to
   `unknown` because its effect is undetermined even when the name resolves.

## Reasons

**1 is semantically correct.** Mutation of a value created inside the function is
unobservable from the caller as long as that value has not escaped. Counting an
unobservable action as an effect turns `pure` from "touches nothing outside" into
"is not written in a particular way", which makes it a style rule rather than
principle P2 (constraining the range of action).

**3 was in fact inflating `unknown`.** In `ambit check src --coverage` on
2026-09-09, 69 of the 131 unresolved sites originating from `builtin-method`
(`Array.push` 50, `Map.set` 13, `Set.add` 6) were destructive methods, and most
of them were appends to locally created arrays and Maps. Principle P4 requires
not hiding what cannot be guaranteed, but continuing to count an unobservable
action as `unknown` is inaccuracy in the opposite direction from hiding — it
shows the guaranteed range as narrower than it is — and it distorts §4.3's
practice of treating the `unknown` rate as a primary KPI. The before/after
measurements are recorded in `docs/status.md`.

Under 3, `state_write` would not exist at all, and a function doing
`param.push(x)` could declare `@effects pure` while that remained only an
`unknown` **warning** — leaving `ambit check`'s exit code at 0 (§4.3). A function
that rewrites its arguments calling itself `pure` runs against §3.4's "do not
pass off an analysis failure as no violation".

## Consequences

This is **not a soundness claim**, and `docs/DESIGN.md` §4.2 says so where the
rule is stated. If a locally created value is handed elsewhere and then mutated
(`sink(out); out.push(x)`), Ambit judges it local mutation. No alias analysis is
performed, and the gap is expressed neither by `boundary` nor by `unknown`.
