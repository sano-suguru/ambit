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

**Fixes:** one `widen` candidate, replacing the `@effects` tag with the
observed set. It is always `consistentWithContract: false` — it loosens the
promise rather than keeping it — and `impact.pureCallersBroken` counts the
callers whose own declaration would no longer cover it. No contract-preserving
candidate is emitted: restoring the declaration means restructuring the code,
which Ambit cannot patch safely, and DESIGN.md §5.3 forbids inventing a
candidate for the sake of ranking.

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
`state_write`,
`llm`, `env`, `process`) — most often a typo. The declaration is rejected
rather than silently narrowed to whatever tokens did parse: the function is
treated as undeclared (not as `pure`) for propagation, so it never also
produces `AMB-E001` for the same tag.

Example: `@effects netwrok` (missing an `r`) instead of `@effects network`.

## AMB-E003

Contract declared on a node that cannot carry one.

**Severity:** error
**Category:** effects

A contract tag (`@effects`, `@capabilities`, `@budget`, `@entrypoint`,
`@boundary`) is written on a function-like node the analysis does not extract, so it has no
symbol to attach the contract to. The declaration is inert: nothing propagates
it, nothing checks it, and it appears in no coverage figure. It is reported for
the same reason a misspelled effect name is (AMB-E002) — a declaration that
silently does nothing reads as a guarantee and is not one.

The message names why the node cannot carry a contract, using the same
classification `--coverage` counts under "skipped": a getter/setter, an
object-literal member with no stable declaration path, an anonymous default
export, a callback passed inline as an argument, or a function declared inside
another function.

Two of those *are* analyzed: a `get`/`set` accessor and an anonymous
`export default` have stable declaration paths (`Cls.get total`, `default`),
so their bodies propagate and `ambit.config.ts` can declare contracts for
them — DESIGN.md §4.1 (a) keeps the config namespace a superset of the JSDoc
one. The comment on them is still inert, so this is still an error, and the
message ends with the config key that would work:
`declare it in ambit.config.ts under "src/cart.ts#Cart.get total" instead`.
DESIGN.md §12 records the asymmetry that leaves.

One case is not a function-like node at all: a contract written on a `class`.
The class's construction *is* analyzed (indexed as `Class.constructor`), but a
class's own comment is never read as its implicit constructor's contract — a
comment about the class is not a verified statement about constructing it. The
message says the contract belongs on the constructor. This case is reported
but not counted under "skipped", which counts function-like nodes.

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

## AMB-E009

Literal target outside the granted capabilities.

**Severity:** error
**Category:** capabilities

A function declaring `@capabilities` performs an operation whose target the
source fixes — a literal URL, or a template literal whose static head already
ends the authority — and no grant covers it. This is the static half of
DESIGN.md §4.4's 二重強制: 「リテラル URL や既知クライアントなど静的に判定
できる違反はチェッカーが止める」.

Reported at the call site, not at the declaration: that is the line to change.
Separate from AMB-E005 because the finding is different — nothing declared
this requirement, the body performs it directly, so there is no callee whose
contract is too wide.

What is matched: `http:<method>:<host>` for the bundled HTTP entry points
(`fetch`, `undici`'s `fetch`, `node:http`/`node:https`'s `get`/`request`). The
method comes from a literal `method` in an options object literal and defaults
to `get`; the host is taken as written, port included and userinfo dropped. A
URL the source does not fix — built at runtime, or a template literal whose
static head stops inside the authority — produces no requirement to compare
and is reported as `AMB-W003` instead, naming the runtime as the place it is
matched. A relative URL names no host and is treated the same way.

No `db:` capability is derived from a SQL statement. §4.4 is explicit that a
hook on a database client does not amount to deciding table-level permission
for arbitrary SQL, and reading a table name out of a literal statement would
be the same claim in a different place.

Example: an entrypoint granting `@capabilities http:get:api.example.com` whose
body calls `fetch("https://elsewhere.example/steal")`.

**Fixes:** none. Widening the grant and changing the URL are both plausible
and Ambit cannot tell which was meant; §5.3 forbids inventing a candidate for
the sake of ranking, and silently widening a capability is the expansion of
authority the tag exists to catch.

## AMB-W003

Declared capabilities reach unknown.

**Severity:** warning
**Category:** capabilities

A function with declared `@capabilities` cannot have its requirement fully
determined. The capability analogue of AMB-W001, and promoted to an error by
`--strict` for the same reason.

The message names which of three causes applies, because they are fixed
differently: a callee that could not be resolved, a `@boundary` callee that
declared no `@capabilities`, or an operation whose target the source does not
fix (a URL built at runtime — see AMB-E009), which §4.4 assigns to the runtime
hook rather than to the checker.

## AMB-E010

`withAmbit` or `ambitHandler` disagrees with the handler's `@capabilities`.

**Severity:** error
**Category:** capabilities

DESIGN.md §4.4 chose explicit registration, so the capability set is written
twice — as `@capabilities` on the handler, and again in the `withAmbit(spec,
handler)` or `ambitHandler(spec, handler, decode)` (the `ambit/runtime/hono`
adapter) beside it. This reports the two disagreeing, as sets of the text each
one wrote. The message names the call the source actually wrote. Order does not matter; anything else does, including a glob on one
side only, since `db:read:*` and `db:read:users` are different grants.

Reported at the call. Neither side is privileged: whichever half an
agent edited, the pair stopped agreeing, and Ambit cannot tell which one the
author meant.

Compared only when all of this holds — otherwise `AMB-W004`:

- the spec is an object literal with no spread, and its `capabilities` is a
  literal array of string literals (a missing `capabilities` key counts as an
  empty grant, which can still disagree);
- the handler is an identifier naming a declaration in the same file that the
  analysis extracted;
- that declaration carries `@entrypoint` or `@capabilities`.

A handler whose `@capabilities` failed to parse is skipped here: `AMB-E004`
already reports that tag, and comparing against a declaration Ambit rejected
would name the wrong problem.

The budget half of the same duplication is `AMB-E011`, reported separately:
each half is fixed by the source on its own, so a spec may write one as a
literal and build the other at runtime.

**Fixes:** none. Aligning the two means choosing which one is right, which is
the decision being reported (§5.3).

## AMB-E011

`withAmbit` or `ambitHandler` disagrees with the handler's `@budget`.

**Severity:** error
**Category:** budget

The budget half of DESIGN.md §4.4's duplication: the limits are written twice,
as `@budget` on the handler and again as `spec.budget` in the `withAmbit(spec,
handler)` or `ambitHandler(spec, handler, decode)` beside it. `spec.budget` is
what the runtime applies; `@budget` is what the source declares. This reports
the two disagreeing — a different `timeMs`, a different `onExceed`, or a limit
present on one side only.

A separate id rather than an extension of `AMB-E010` because that diagnostic's
`contract` field is capability text (`declared` / `required` / `excess`), which
a budget disagreement has nothing honest to put in, and because the category
that belongs on it is `budget`, not `capabilities`.

`onExceed` is compared **after** both sides are defaulted to `throw`.
`parseBudgetTag` writes the default into a `@budget` that omits it, and the
runtime defaults an omitted `spec.budget.onExceed` the same way, so the JSDoc
side has no absent state for an absent spec key to disagree with. The numeric
limits are not defaulted: `timeMs=500` against no `timeMs` is a real
disagreement, and is reported as one.

Compared only when all of this holds — otherwise `AMB-W004`:

- the spec is an object literal with no spread, and its `budget`, when
  present, is an object literal whose keys are `timeMs` / `costUsd` /
  `llmCalls` / `onExceed` and whose values are literals (a missing `budget`
  key counts as no budget, which can still disagree with a declared one);
- the handler is an identifier naming a declaration in the same file that the
  analysis extracted.

A handler whose `@budget` failed to parse is skipped here, for the reason
`AMB-E010` skips an unparsed `@capabilities`: `AMB-E008` already reports that
tag.

**Fixes:** none, for `AMB-E010`'s reason — which of the two is right is the
decision being reported.

## AMB-W004

`withAmbit` or `ambitHandler` was not compared with a declared contract.

**Severity:** warning
**Category:** capabilities

A `withAmbit(spec, handler)` or an adapter's `ambitHandler(spec, handler,
decode)` was found, but one of `AMB-E010`'s or `AMB-E011`'s conditions does not
hold: the capability list is built at runtime, the budget is not an object
literal of literal limits, the handler is not a declaration in the same file,
or the handler declares neither `@entrypoint` nor `@capabilities`. The message
names which.

The two halves are reported independently, so one registration can produce a
compared capability set and an uncompared budget, or the reverse. Collapsing
the wrapper to a single warning the moment either half was dynamic would drop
a check the source does support.

Reported rather than skipped for the reason `AMB-E003` reports an inert
declaration: a wrapper that produced no diagnostic at all would read as
"checked and agreed".

Not an error, and not promoted by `--strict`. The comparison is on the source
only; matching a contract to the handler that actually runs — after a build
strips the comments, or a bundler moves it — is DESIGN.md §12's
「契約とハンドラの対応付け」 and is still open.

## AMB-W005

JSDoc and `ambit.config.ts` declare the same tag differently.

**Severity:** warning
**Category:** effects

One symbol has both a JSDoc contract and a `contracts` entry, and for at least
one of the five tags the two do not say the same thing. DESIGN.md §4.1 settles
which wins — 「同一シンボルに JSDoc と config の両方があれば JSDoc を優先し、
差異を警告する」 — so the run proceeds with the JSDoc declaration and this
diagnostic reports what was ignored.

Compared tag by tag, on the parsed values rather than on the text: `@effects
db_read, network` and `effects: ["network", "db_read"]` are the same
declaration and are not reported. A tag only one side declares is not a
difference either — it is the other side filling a gap, which is the normal
way a config supplements code it cannot edit.

A warning rather than an error, because the specified behaviour is exactly
what happened. It is still reported for AMB-E003's reason: a config entry the
author believes is in force, and is not, is a declaration that does nothing.

Not promoted by `--strict`, in either its command-line or its per-directory
form. `--strict` means "an unverified path is not acceptable here" (§4.2 rule
3); a disagreement between two declarations is a different thing.

No fix is offered. Deleting the config entry and rewriting the JSDoc are
opposite intentions, and §5.3 forbids inventing a candidate to fill the slot.

## AMB-W006

A `contracts` key matches nothing.

**Severity:** warning
**Category:** effects

An exact `contracts` key — one whose file half contains no `*` — named no
declaration in what was analyzed. The contract it declares is not in force,
which is AMB-E003's failure in a different file: a declaration that silently
applies to nothing reads as a guarantee and is not one.

Only exact keys are reported. A glob is written to cover whatever is there,
and `ambit check src/domain` legitimately matches none of a
`src/legacy/**` pattern; reporting those would make the diagnostic noisiest
exactly when the run is narrowest.

The location is the key's own line in the config file, found textually — the
config is loaded by importing it, not by parsing it, so a key built by an
expression rather than written literally falls back to the file's first
character.

Common causes: a typo in the symbol half, a declaration path that is not what
the checker uses (`Cls.get total`, not `Cls.total` — DESIGN.md §4.1 (a)), or a
key naming a file outside the directory being checked.

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

## AMB-I001

Contract proposal.

**Severity:** info
**Category:** effects

Emitted by `ambit init`, never by `ambit check`. A function has no `@effects`
tag and its effects were fully resolved, so the tag can be written for it
(DESIGN.md §4.1). The fix carries a concrete patch adding the tag — into the
declaration's existing JSDoc block when it has exactly one, otherwise as a new
block above it — and is `consistentWithContract: true`: adding a declaration
where there was none cannot contradict one, and the set proposed is exactly
what was observed.

A class that writes no constructor gets a proposal with **no** patch: its
construction has real effects (property initializers, the base constructor),
but there is no declaration site to attach a contract to, and a comment above
the `class` would be inert (AMB-E003). The message says to write an explicit
constructor. Reporting it with no fix beats either proposing a patch that
changes nothing or staying silent about effects that are real.

No proposal is made when the function's effects reached `unknown`. Declaring
`@effects pure` for a function the analysis could not resolve would convert
"could not tell" into a guarantee, which is the thing `unknown` exists to
prevent (§4.3). Those functions stay undeclared and keep appearing in
`--coverage`.

`ambit init` exits 0 regardless of how many proposals it makes: contracts left
to write are not a failed check.
