# Diagnostic codes

Living ledger of Ambit's diagnostic codes, appended as they are implemented.

Before the first npm publish (1.0), IDs are **not** guaranteed stable and may
still be renumbered or reworded. From the first publish onward, DESIGN.md
§5.2 applies: an `id` is never deleted or reused, and a meaning change
requires an RFC (§9).

Message text is written in English; this file is written in English as well,
independent of the project's Japanese-language documentation policy — see
`AGENTS.md`.

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

Declared effects reach unknown.

**Severity:** warning
**Category:** effects

A function with a declared `@effects` set (including `pure`) calls a
function whose effects could not be resolved (DESIGN.md §4.2, rule 3). This
does not by itself mean a violation occurred — `unknown` may resolve to a
set already covered by the declaration once the callee is annotated or a
stub is added — but the declaration is not yet backed by a verified
guarantee.

Example: a function declared `@effects pure` or `@effects network` calls
`eval(...)` or a function with an unresolved call graph.

## AMB-E002

Unknown effect name in `@effects`.

**Severity:** error
**Category:** effects

An `@effects` tag contains a token that is neither `pure` nor one of the
known effects (`network`, `db_read`, `db_write`, `fs_read`, `fs_write`,
`llm`, `env`, `process`) — most often a typo. The declaration is rejected
rather than silently narrowed to whatever tokens did parse: the function is
treated as undeclared (not as `pure`) for propagation, so it never also
produces `AMB-E001` for the same tag.

Example: `@effects netwrok` (missing an `r`) instead of `@effects network`.

## AMB-E003

Contract declared on a node that cannot carry one.

**Severity:** error
**Category:** effects

A contract tag (`@effects`, `@capabilities`, `@budget`, `@entrypoint`) is
written on a function-like node the analysis does not extract, so it has no
symbol to attach the contract to. The declaration is inert: nothing propagates
it, nothing checks it, and it appears in no coverage figure. It is reported for
the same reason a misspelled effect name is (AMB-E002) — a declaration that
silently does nothing reads as a guarantee and is not one.

The message names why the node cannot carry a contract, using the same
classification `--coverage` counts under "skipped": a getter/setter, an
object-literal member with no stable declaration path, an anonymous default
export, a callback passed inline as an argument, or a function declared inside
another function.

Example: `/** @effects fs_read */ get value() { … }`.

Note this is narrower than it was: an object-literal member *can* carry a
contract when the literal is a module-scope `const` and the member has an
identifier name. See `docs/limitations.md`.

## AMB-E004

Malformed `@capabilities`.

**Severity:** error
**Category:** capabilities

A `@capabilities` tag is not a comma-separated list of
`<resource>:<action>:<target>` (DESIGN.md §4.4). All three segments must be
non-empty, and only `target` may contain a glob (`*`, `?`) — a `*` in the
resource or action segment reads as a restriction while meaning the opposite,
so it is rejected. The target may itself contain a colon
(`http:get:localhost:8080`).

The whole tag is rejected rather than partly honoured, and the function is
treated as granting nothing — so it never also produces AMB-E005 for the same
tag. Same rule as AMB-E002.

Example: `@capabilities db:read` (two segments), `@capabilities *:read:users`
(glob outside the target).

## AMB-E005

Capability escalation.

**Severity:** error
**Category:** capabilities

A function declaring `@capabilities` reaches a callee that requires a
capability the declaration does not grant (DESIGN.md §4.4: capabilities may
only narrow from caller to callee). `contract.excess` lists the ungranted
capabilities and `contract.via` the call path to the one reported.

A capability is granted when the resource and action match exactly and the
grant's target, treated as a glob, matches the required target — so
`db:read:*` covers `db:read:users`.

The check crosses undeclared functions: `A` granting `db:read:users`, calling
an undeclared `B`, which calls a `C` declaring `db:write:users`, is a
violation in `A`. An undeclared hop does not launder an escalation.

Example: a function declaring `@capabilities db:read:users` that calls one
declaring `@capabilities db:write:users`.

## AMB-W003

Declared capabilities reach unknown.

**Severity:** warning
**Category:** capabilities

A function with declared `@capabilities` reaches a call that could not be
resolved, so what it actually requires is not fully known. The capability
analogue of AMB-W001, and promoted to an error by `--strict` for the same
reason.

## AMB-W002

Entrypoint with no capabilities.

**Severity:** warning
**Category:** capabilities

A function marked `@entrypoint` declares no `@capabilities`. An entrypoint is
where `@ambit/runtime` would establish a capability context (DESIGN.md §4.4);
one with no declared set establishes nothing to check against. §4.4:
「未指定は unknown 相当として警告」.

## AMB-E006

`@boundary` with no reason.

**Severity:** error
**Category:** boundary

DESIGN.md §4.6 makes `reason` mandatory on `@boundary`
(`@boundary reason="legacy SDK, not annotated"`). A boundary is an explicit,
recorded decision to stop checking a body; without a reason it is an
unexplained hole, which is the thing the tag exists to make visible.

## AMB-E007

`@boundary` with no contract to trust.

**Severity:** error
**Category:** boundary

A `@boundary` function declares no `@effects`. §4.6's bargain is "do not check
inside; trust what is declared to the outside" — with nothing declared, there
is nothing to trust, and the tag only removes checking. The function's effects
become `unknown`, so callers still see the hole, but the declaration itself is
reported: a tag that only subtracts a guarantee should not look like one.

## AMB-E008

Malformed `@budget`.

**Severity:** error
**Category:** budget

A `@budget` tag is not a space-separated list of `key=value` pairs with keys
`timeMs`, `costUsd`, `llmCalls`, and an optional `onExceed` of `throw`
(default), `warn`, or `abort` (DESIGN.md §4.5). Limits must be finite and
non-negative, `llmCalls` an integer, no key repeated, and at least one limit
present — `@budget onExceed=warn` declares a policy with nothing to exceed.

Rejected whole rather than partly applied, for the reason AMB-E002 rejects a
misspelled effect name.
