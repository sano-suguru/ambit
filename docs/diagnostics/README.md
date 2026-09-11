# Diagnostic codes

The reference for every code `ambit` emits: what happened, why, and how to fix
it. Design rationale is not repeated here — where a rule comes from, DESIGN.md
is cited by section.

An `id` and its meaning are part of the guaranteed surface (DESIGN.md §9.2): a
change to either is announced in `CHANGELOG.md` at the release that makes it.
While the major version is 0, such a change may land in a minor release (§9.3).
From 1.0, §5.2's stronger rule applies: an `id` is never deleted or reused, and
a meaning change requires an RFC (§9.1).

| Code | Severity | Category | Meaning |
|---|---|---|---|
| [AMB-E001](#amb-e001) | error | effects | Declared effects exceeded |
| [AMB-E002](#amb-e002) | error | effects | Unknown effect name in `@effects` |
| [AMB-E003](#amb-e003) | error | effects | Contract declared on a node that cannot carry one |
| [AMB-W001](#amb-w001) | warning | effects | Declared effects reach `unknown` |
| [AMB-W005](#amb-w005) | warning | effects | JSDoc and `ambit.config.ts` disagree |
| [AMB-W006](#amb-w006) | warning | effects | A `contracts` key matches nothing |
| [AMB-E004](#amb-e004) | error | capabilities | Malformed `@capabilities` |
| [AMB-E005](#amb-e005) | error | capabilities | Capability escalation |
| [AMB-E009](#amb-e009) | error | capabilities | Literal target outside the granted capabilities |
| [AMB-E010](#amb-e010) | error | capabilities | A registration disagrees with the handler's `@capabilities` |
| [AMB-W002](#amb-w002) | warning | capabilities | Entrypoint with no capabilities |
| [AMB-W003](#amb-w003) | warning | capabilities | Declared capabilities reach `unknown` |
| [AMB-W004](#amb-w004) | warning | capabilities | A registration was not compared with a declared contract |
| [AMB-E008](#amb-e008) | error | budget | Malformed `@budget` |
| [AMB-E011](#amb-e011) | error | budget | A registration disagrees with the handler's `@budget` |
| [AMB-E006](#amb-e006) | error | boundary | `@boundary` with no reason |
| [AMB-E007](#amb-e007) | error | boundary | `@boundary` with no contract to trust |
| [AMB-I001](#amb-i001) | info | effects | Contract proposal (`ambit init`) |
| [AMB-I002](#amb-i002) | info | effects | No contract can be proposed, and why (`ambit init`) |

---

## AMB-E001

Declared effects exceeded.

**Severity:** error · **Category:** effects

The function's declared `@effects` set does not contain an effect observed
either directly in its body or propagated from a callee (DESIGN.md §4.2 rule 1).

**Example:** A function declared `@effects pure` calls another function that performs a `fetch`.

**How to fix:** Remove the effect from the body, or deliberately widen the declaration. Widening loosens a promise other functions may depend on.

**Fixes:** One `widen` candidate replacing the `@effects` tag with the observed set, always `consistentWithContract: false`. No contract-preserving candidate is emitted: restoring the declaration means restructuring the code, and §5.3 forbids inventing a candidate for the sake of ranking.

**Fields:** `contract.declared`, `contract.observed`, `contract.via`, `contract.operation`, `fixes[].impact.pureCallersBroken`.

## AMB-E002

Unknown effect name in `@effects`.

**Severity:** error · **Category:** effects

An `@effects` tag contains a token that is neither `pure` nor one of the known
effects (`network`, `db_read`, `db_write`, `fs_read`, `fs_write`, `state_write`,
`llm`, `env`, `process`) — most often a typo.

The tag is rejected whole rather than narrowed to the tokens that did parse: the
function is treated as **undeclared**, not as `pure`, so `AMB-E001` never
co-occurs for the same tag.

**Example:** `@effects netwrok` instead of `@effects network`.

**How to fix:** Correct the name, or define it in `ambit.config.ts`'s `effects` map as a combination of standard effects (DESIGN.md §4.1 (d)).

## AMB-E003

Contract declared on a node that cannot carry one.

**Severity:** error · **Category:** effects

A contract tag is written on a function-like node the analysis does not extract,
so there is no symbol to attach it to. The declaration is inert: nothing
propagates it and nothing checks it. It is reported for the same reason a
misspelled effect name is — a declaration that silently does nothing reads as a
guarantee and is not one.

The message names why, using the same classification `--coverage` counts under
`skipped`: a getter/setter, an object-literal member with no stable declaration
path, an anonymous default export, an inline callback argument, a function
declared inside another function, or a declaration with no body.

**Example:** `/** @effects fs_read */ get value() { … }`

**How to fix:** Depends on which case the message names:

| Case | Fix |
|---|---|
| accessor, or anonymous `export default` | Declare it in `ambit.config.ts` — the message ends with the key that works (`"src/cart.ts#Cart.get total"`). These have declaration paths; JSDoc on them is refused by §4.1 (a) |
| overload signature, `abstract` member, `.ts`-file `declare` | Move the contract to the implementation. An overload set is one runtime function, and the implementation is it (§4.1, "Overloads and bodyless declarations") |
| `declare function` with no implementation anywhere | Nothing to move it to. That code needs a stub (`src/stubs/`); until it has one, calls to it are honestly `unknown` |
| a contract written on a `class` | Move it to the constructor. A comment about the class is not a verified statement about constructing it |
| anything else in the `skipped` list | The node cannot carry a contract at all. See [`docs/analysis-limitations.md`](../analysis-limitations.md) |

A call into an overload set with no implementation in the project is `unknown`
(`overload-without-body` in `--coverage`), not `pure`.

## AMB-W001

Declared effects reach `unknown`.

**Severity:** warning · **Category:** effects

A function with a declared `@effects` set (including `pure`) calls a function
whose effects could not be resolved (§4.2 rule 3). This is not itself a
violation — `unknown` may resolve to a set the declaration already covers — but
the declaration is not yet backed by a verified guarantee.

**Example:** A function declared `@effects pure` calls `eval(...)`, or a function with an unresolved call graph.

**How to fix:** Annotate the callee, add a stub, or isolate it behind `@boundary` — which §4.3 tallies separately from succeeding at analysis.

**Strict mode:** Promoted to an error by `--strict`, and by a `strict` glob in `ambit.config.ts` matching the file it is reported in (§4.3). The two are a union: a config listing fewer directories never narrows a `--strict` run.

## AMB-W005

JSDoc and `ambit.config.ts` declare the same tag differently.

**Severity:** warning · **Category:** effects

One symbol has both a JSDoc contract and a `contracts` entry, and for at least
one of the five tags they do not say the same thing. §4.1 settles which wins —
JSDoc — so the run proceeds with the JSDoc declaration and this reports what was
ignored.

Compared tag by tag on **parsed values**, not text: `@effects db_read, network`
and `effects: ["network", "db_read"]` are the same declaration. A tag only one
side declares is not a difference; that is a config supplementing code it cannot
edit.

**How to fix:** Delete the config entry, or change the JSDoc to match. No fix is emitted: the two are opposite intentions (§5.3).

**Strict mode:** Not promoted, in either form. `--strict` means "an unverified path is not acceptable here"; a disagreement between two declarations is a different thing.

## AMB-W006

A `contracts` key matches nothing.

**Severity:** warning · **Category:** effects

An exact `contracts` key — one whose file half contains no `*` — named no
declaration in what was analyzed, so the contract it declares is not in force.

Only exact keys are reported. A glob is written to cover whatever is there, and
`ambit check src/domain` legitimately matches none of a `src/legacy/**` pattern.

**How to fix:** Common causes: a typo in the symbol half; a declaration path that is not what the checker uses (`Cls.get total`, not `Cls.total` — §4.1 (a)); or a key naming a file outside the directory being checked.

**Location:** The key's own line in the config, found textually. The config is loaded by importing it, not by parsing it, so a key built by an expression rather than written literally falls back to the file's first character.

## AMB-E004

Malformed `@capabilities`.

**Severity:** error · **Category:** capabilities

A `@capabilities` tag is not a comma-separated list of
`<resource>:<action>:<target>` (§4.4). All three segments must be non-empty, and
only `target` may contain a glob — a `*` in the resource or action segment reads
as a restriction while meaning the opposite. The target may itself contain a
colon (`http:get:localhost:8080`).

The tag is rejected whole and the function grants nothing, so `AMB-E005` never
co-occurs for the same tag.

**Example:** `@capabilities db:read` (two segments); `@capabilities *:read:users` (glob outside the target).

## AMB-E005

Capability escalation.

**Severity:** error · **Category:** capabilities

A function declaring `@capabilities` reaches a callee requiring a capability the
declaration does not grant. Capabilities may only **narrow** from caller to
callee (§4.4).

A capability is granted when resource and action match exactly and the grant's
target, treated as a glob, matches the required target — so `db:read:*` covers
`db:read:users`.

The check crosses undeclared functions: `A` granting `db:read:users`, calling an
undeclared `B`, which calls a `C` declaring `db:write:users`, is a violation in
`A`. An undeclared hop does not launder an escalation.

**Example:** A function declaring `@capabilities db:read:users` calls one declaring `@capabilities db:write:users`.

**How to fix:** Narrow the callee, or widen the caller's grant deliberately — which `ambit diff` will report as an authority increase needing an approval (§6.3).

**Fields:** `contract.declared`, `contract.required`, `contract.excess`, `contract.via`.

## AMB-E009

Literal target outside the granted capabilities.

**Severity:** error · **Category:** capabilities

A function declaring `@capabilities` performs an operation whose target the
source fixes — a literal URL, or a template literal whose static head already
ends the authority — and no grant covers it. This is the static half of §4.4's
dual enforcement.

Reported at the **call site**, not the declaration: that is the line to change.
Separate from `AMB-E005` because nothing declared this requirement; the body
performs it directly, so there is no callee whose contract is too wide.

What is matched: `http:<method>:<host>` for the bundled HTTP entry points
(`fetch`, `undici`'s `fetch`, `ky`, `node:http`/`node:https`'s `get`/`request`,
the last of these under either spelling of the module specifier). The method
comes from a literal `method` in an options object literal and defaults to
`get`, except where the operation's own name already fixes it (`ky.post`); the host is taken as written, port included and userinfo dropped.

A URL the source does not fix produces no requirement to compare, and is
`AMB-W003` instead. **No `db:` capability is derived from a SQL statement** —
reading a table name out of a literal statement would be the table-level claim
§4.4 refuses to make.

**Example:** An entrypoint granting `@capabilities http:get:api.example.com` whose body calls `fetch("https://elsewhere.example/steal")`.

**How to fix:** Change the URL, or widen the grant. **No fix is emitted**: both are plausible and Ambit cannot tell which was meant, and silently widening a capability is the expansion of authority the tag exists to catch.

## AMB-E010

`withAmbit` or an adapter's `ambitHandler` / `ambitRoute` disagrees with the
handler's `@capabilities`.

**Severity:** error · **Category:** capabilities

The capability set that reaches the runtime is the one in the registration
beside the handler (§4.4). A literal one *is* the handler's `@capabilities`, so
the tag need not repeat it — but where both are written and they disagree, this
reports it, as sets of the text each side wrote. Order does not matter; anything
else does, including a glob on one side only.

Neither side is privileged: whichever half was edited, the pair stopped
agreeing, and Ambit cannot tell which one the author meant.

**Compared only when:** Both must hold, or it is `AMB-W004` instead:

- the spec is an object literal with no spread, and its `capabilities` is a
  literal array of string literals (a missing key counts as an empty grant,
  which can still disagree);
- the handler is an identifier naming a declaration in the same file that the
  analysis extracted.

A handler whose `@capabilities` failed to parse is skipped — `AMB-E004` already
reports that tag.

**How to fix:** Choose which side is right and delete or correct the other. No fix is emitted: choosing is the decision being reported (§5.3).

## AMB-W002

Entrypoint with no capabilities.

**Severity:** warning · **Category:** capabilities

A function marked `@entrypoint` declares no `@capabilities`. An entrypoint is
where `ambit-ts/runtime` establishes a capability context (§4.4); one with no
declared set establishes nothing to check against.

**How to fix:** Declare `@capabilities` on it, in JSDoc, in `ambit.config.ts`, or as a literal `capabilities` in the `spec` beside it.

## AMB-W003

Declared capabilities reach `unknown`.

**Severity:** warning · **Category:** capabilities

A function with declared `@capabilities` cannot have its requirement fully
determined — the capability analogue of `AMB-W001`.

The message names which of three causes applies, because they are fixed
differently:

| Cause | Fix |
|---|---|
| a callee that could not be resolved | annotate it, or add a stub |
| a `@boundary` callee that declared no `@capabilities` | declare them on the boundary |
| an operation whose target the source does not fix (a URL built at runtime) | nothing here — §4.4 assigns it to the runtime hook |

**Strict mode:** Promoted to an error by `--strict`, and by a matching `strict` glob (§4.3).

## AMB-W004

`withAmbit`, `ambitHandler` or `ambitRoute` was not compared with a declared
contract.

**Severity:** warning · **Category:** capabilities

A registration was found, but one of `AMB-E010`'s or `AMB-E011`'s conditions
does not hold: the capability list is built at runtime, the budget is not an
object literal of literal limits, or the handler is not a declaration in the
same file. The message names which.

**A spec Ambit cannot read declares nothing.** This is where the single-source
rule stops: everywhere else a literal spec supplies the handler's
`@capabilities` / `@budget`, and here it does not, leaving the handler's own
JSDoc as the only declaration there is.

The two halves are reported independently, so one registration can produce a
compared capability set and an uncompared budget, or the reverse.

**How to fix:** Write the contract in the handler's JSDoc. Dropping the tag beside one of these registrations does not make the contract implicit — it makes it missing, and the entrypoint is then `AMB-W002` on top of this warning.

**Strict mode:** Not promoted. The comparison is on the source only; matching a contract to the handler that actually runs — after a build strips comments, or a bundler moves it — is [`docs/open-questions.md`](../open-questions.md)'s "Mapping contracts to handlers", still open.

## AMB-E008

Malformed `@budget`.

**Severity:** error · **Category:** budget

A `@budget` tag is not a space-separated list of `key=value` pairs with keys
`timeMs`, `costUsd`, `llmCalls`, and an optional `onExceed` of `throw`
(default), `warn`, or `abort` (§4.5). Limits must be finite and non-negative,
`llmCalls` an integer, no key repeated, and at least one limit present —
`@budget onExceed=warn` declares a policy with nothing to exceed.

Rejected whole rather than partly applied, for `AMB-E002`'s reason.

## AMB-E011

`withAmbit` or an adapter's `ambitHandler` / `ambitRoute` disagrees with the
handler's `@budget`.

**Severity:** error · **Category:** budget

The budget half of `AMB-E010`'s rule: `spec.budget` is what the runtime applies,
and a literal one is also what the source declares, so `@budget` on the handler
is optional beside it. Where both are written, this reports them disagreeing — a
different `timeMs`, a different `onExceed`, or a limit present on one side only.

A separate id rather than an extension of `AMB-E010` because that diagnostic's
`contract` field is capability text, which a budget disagreement has nothing
honest to put in, and because the category that belongs on it is `budget`.

`onExceed` is compared **after** both sides are defaulted to `throw`. The
numeric limits are not defaulted: `timeMs=500` against no `timeMs` is a real
disagreement.

**Compared only when:** Both must hold, or it is `AMB-W004`:

- the spec is an object literal with no spread, and its `budget`, when present,
  is an object literal whose keys are `timeMs` / `costUsd` / `llmCalls` /
  `onExceed` and whose values are literals;
- the handler is an identifier naming a declaration in the same file that the
  analysis extracted.

A handler whose `@budget` failed to parse is skipped — `AMB-E008` reports it.

## AMB-E006

`@boundary` with no reason.

**Severity:** error · **Category:** boundary

§4.6 makes `reason` mandatory on `@boundary`. A boundary is an explicit,
recorded decision to stop checking a body; without a reason it is an unexplained
hole, which is the thing the tag exists to make visible.

**How to fix:** `@boundary reason="legacy SDK, not annotated"`

## AMB-E007

`@boundary` with no contract to trust.

**Severity:** error · **Category:** boundary

A `@boundary` function declares no `@effects`. §4.6's bargain is "do not check
inside; trust what is declared to the outside" — with nothing declared there is
nothing to trust, and the tag only removes checking.

The function's effects become `unknown`, so callers still see the hole; the
declaration itself is reported because a tag that only subtracts a guarantee
should not look like one.

**How to fix:** Add `@effects` alongside the boundary, declaring what it does to the outside.

## AMB-I001

Contract proposal.

**Severity:** info · **Category:** effects

Emitted by `ambit init`, never by `ambit check`. A function has no `@effects`
tag and its effects were fully resolved, so the tag can be written for it.

**Fixes:** A concrete patch adding the tag — into the declaration's existing JSDoc block when it has exactly one, otherwise as a new block above it — marked `consistentWithContract: true`: adding a declaration where there was none cannot contradict one, and the set proposed is exactly what was observed.

Three kinds of declaration have a stable symbol id and nowhere to write a
comment: a `get`/`set` accessor, an anonymous `export default` (§4.1 (a)), and a
class that writes no constructor. For those, `init` reports the inferred effects
with **no** patch and names the `ambit.config.ts` key that would carry them;
`ambit init --config` produces that patch, appending one `contracts` entry to an
existing `contracts: {` line. Without a config file the proposal carries no fix
and says so — creating a config file means guessing the `defineConfig` specifier
from how the consumer installed Ambit, which §5.3 forbids.

**No proposal:** When the function's effects reached `unknown`. Declaring `@effects pure` for a function the analysis could not resolve would convert "could not tell" into a guarantee (§4.3). Those functions stay undeclared, keep appearing in `--coverage`, and get an `AMB-I002` where the unresolvable call is in their own body.

`ambit init` exits 0 regardless of how many proposals it makes: contracts left
to write are not a failed check.

## AMB-I002

No contract can be proposed, and why.

**Severity:** info · **Category:** effects

Emitted by `ambit init`, never by `ambit check`. A function has no `@effects`
tag, is not behind `@boundary`, its propagated effects reached `unknown`, and
its **own** body holds a call that could not be resolved — so `AMB-I001` has
nothing to propose. The prohibition is unchanged; what this adds is the reason.

One diagnostic per function, whatever the number of unresolved calls. The first
line names the function and how many calls stopped the inference; each line
after it is one call — its qualified name where one could be built, its
`file:line`, its reason, and what that reason implies.

**Reasons:**
| Reason | What it implies |
|---|---|
| `external-module` | Declared in a package under `node_modules`. A stub for that package resolves it; `@boundary reason="<package>"` isolates it instead, which `--coverage` tallies separately from analysis (§4.3) |
| `import-binding` | An import binding that follows to no declaration — check the module specifier or the named export first, then the two routes above |
| `ambient-declaration` | Declared in a `.d.ts` belonging to this project: a contract written on that declaration resolves it |
| `builtin-method` | A TypeScript default-lib method Ambit's own tables do not name. **A gap in Ambit**, not in the code being checked |
| `callback-parameter` | A callback parameter called directly. §4.2 rule 4 infers its effects from the actual argument at each call site, so the callers decide it |
| `callback-by-reference` | A callback handed to a mutator (`xs.sort(cmp)`). Same rule, same conclusion |
| `any-typed` | The callee's type is `any`, so nothing identifies it (§4.2 rule 6). A type annotation on that value restores the call |
| `dynamic-import`, `eval`, `new-function` | Not analyzable by design (§4.2 rule 6) |
| `overload-without-body` | Reaches a declaration with no implementation in the project (§4.1) |
| `unresolved-symbol` | No single declaration Ambit can follow — a nested function, or a receiver with no one object literal certainly behind it (§4.2 rule 7) |

`callback-by-reference` is the one label here that is not an `UnresolvedReason`:
the site is a mutation carrying a by-reference callback, not an unresolved call,
but it leaves the caller incomplete for the same reason `callback-parameter`
does.

**Fixes:** **None, ever.** Every route above is either a decision only a person can make or work on Ambit itself, and §5.3 defines `fixes[].edits` as concrete applicable patches. `@boundary` in particular is never proposed: §4.3 tallies a boundary separately from succeeding at analysis, so a tool that generated one would be generating movement in its own primary KPI ([ADR-0011](../adr/0011-reporting-why-a-contract-cannot-be-proposed.md)).

No `contract` field either. `EffectsContract.observed` has no spelling for
`unknown`, so listing the effects that did resolve would read as the complete
set — the claim this diagnostic exists to deny.

A function that merely inherited `unknown` from a callee is **not** reported.
The callee that holds the call is; repeating it once per caller would be volume
rather than information.
