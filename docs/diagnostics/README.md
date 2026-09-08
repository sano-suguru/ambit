# Diagnostic codes

Living ledger of Ambit's diagnostic codes, appended as they are implemented.

Before the first npm publish (1.0), IDs are **not** guaranteed stable and may
still be renumbered or reworded. From the first publish onward, DESIGN.md
§5.2 applies: an `id` is never deleted or reused, and a meaning change
requires an RFC (§9).

Message text is written in English; this file is written in English as well,
independent of the project's Japanese-language documentation policy — see
`CLAUDE.md`.

## AMB-E001

Declared effects exceeded.

**Severity:** error
**Category:** effects

The function's declared `@effects` set does not contain an effect that was
observed either directly in its body or propagated from a callee (DESIGN.md
§4.2, rule 1). `contract.via` lists the call path from the declaring function
to the function where the effect was found, when propagation crossed at
least one call.

Example: a function declared `@effects pure` calls another function that
performs a `fetch`.

## AMB-W001

Pure reaches unknown.

**Severity:** warning
**Category:** effects

A function declared `@effects pure` calls a function whose effects could not
be resolved (DESIGN.md §4.2, rule 3). This does not by itself mean a
violation occurred — `unknown` may resolve to `pure` once the callee is
annotated or a stub is added — but the declaration is not yet backed by a
verified guarantee.
