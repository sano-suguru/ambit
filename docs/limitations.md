# Known limitations

Implementation status of `ambit check` — what the analysis actually sees
today, and where it stops. This file records current behavior, not design
intent; the specification is [DESIGN.md](DESIGN.md), and design-level open
questions live in its §12 (未解決の問題).

Ambit is experimental. Expect this file to shrink as the analysis grows.

## Contract tags

Only `@effects` is enforced. `@capabilities`, `@budget`, and `@entrypoint`
are specified in DESIGN.md as part of the contract model, but nothing in
`src/` parses or checks them yet — only the diagnostic *category* names
exist.

Runtime enforcement has not been started. Everything Ambit checks today is
static.

## Commands and flags

`ambit check` is the only implemented command. `ambit init`, `ambit run`,
`ambit agent`, `ambit stubs`, and `ambit sbom` are planned, not built.

`check --strict` is not implemented. Passing it fails with exit 2 rather than
being silently ignored.

## Effect inference

Effects are inferred from two bundled tables.

### The stub table (`src/stubs/node-builtins.ts`)

26 entries — `fetch`, `undici`'s `fetch`, plus Node.js builtins — producing
only `network`, `fs_read`, `fs_write`, and `process`. No bundled stub
produces `db_read`, `db_write`, `llm`, or `env`; those effects enter the
analysis only when something declares them explicitly. A `pure` function
calling a database driver therefore reports `unknown`, not a violation.

Matching is import-shape sensitive. Lookup keys are built from the *module
specifier text* plus the imported property/export name, so:

- `import * as fs from "node:fs"; fs.writeFileSync(...)` is recognized
- `import fs from "node:fs"; fs.writeFileSync(...)` is recognized
- `import { writeFileSync } from "node:fs"; writeFileSync(...)` is recognized
  (a local `as` alias doesn't affect matching — the imported name is used)

A destructured or re-exported binding several hops away (e.g. through a
barrel file) is not resolved to its originating module specifier.

### The pure built-ins allowlist (`src/stubs/pure-builtins.ts`)

A separate, smaller table allowlists default-lib methods reached through a
local value (`set.has(...)`, `arr.map(...)`). These have no import binding for
the stub table to key on, so they are named by their default-lib type and
method (`Set.has`, `Array.map`) in a namespace kept separate from the
module-specifier one.

It is deliberately narrow:

- Anything that mutates is excluded — `Array.push`, `Array.sort`, `Map.set`,
  `Set.add`.
- A method that can take a callback (`map`, `filter`, `reduce`, …) is trusted
  only when that callback is written inline. `arr.map(x => ...)` is walked and
  its effects attributed to the enclosing function; `arr.map(namedFn)` passes
  a callback Ambit never sees, so the call stays `unknown` even though
  `Array.map` itself is allowlisted.

### Call resolution

A call is followed to its target only when the callee's declaration is one the
backend extracts. `handlers.read()` is resolved through the receiver's *value*
rather than its static type, so a type annotation on `handlers` does not change
the outcome — what matters is whether one object literal certainly stands
behind the receiver. These are followed:

- `const handlers = { read() { … } }` and `{ read: () => … }` — the member is
  extracted and has its own contract
- `const handlers = { read: readIt }` and `{ readIt }` — the member names an
  already-extracted function, and the call resolves to that function
- the same with `satisfies` or `as const`, which assert a type without changing
  the value
- a class instance method (`client.read()`)

These are not:

- a receiver with no single literal behind it — a parameter (`function f(d: D)
  { d.run() }`), a class property, an import of a value built elsewhere. Any
  object satisfying the type could arrive at runtime.
- a `let` or `var` receiver, which may hold a different object by the time the
  call runs
- a literal containing a spread, which can carry members this analysis cannot
  enumerate
- a member with a computed, string, or numeric name (`{ ["a-b"]: … }`,
  `{ "x y"() { … } }`) — there is no declaration path for it, see Function
  extraction below
- a literal that is not a module-scope `const`'s own initializer — one nested in
  another literal, declared inside a function body, or passed inline as an
  argument
- a nested function declaration — one declared inside another function's body

**This is not soundness.** `const` freezes the binding, not the properties, so
`handlers.read = other` still defeats it. Resolving a class instance method
rests on exactly the same assumption; following the value adds no new one, and
neither is a guarantee.

An unfollowed call keeps the "unknown stays unknown" property: it is reported as
unresolved, becomes `unknown` in the enclosing function, and raises `AMB-W001`
if that function declares a contract. It is counted under `unresolved-symbol` in
`--coverage`, and — where the callee is a property access — counted without a
name, because a name is only built for a bare identifier or a property access on
an import binding. See Reading `--coverage` below.

### Higher-order functions

Inferring a callback's effects from the argument passed at the call site is
not implemented. A call through a callback parameter falls back to `unknown`.

### `new X(...)`

Constructor calls are not recorded as calls at all — not even as `unknown`.
`new PrismaClient()` or `new WebSocket(...)` disappears from the analysis
entirely, and a `pure` function that constructs a database client or a socket
passes today. `new Function(...)` is the sole exception: it is reported as an
`eval`-like unresolved call.

This is the one place where the "unknown stays unknown" property does not
hold, and the gap is invisible in `--coverage` output.

## Function extraction

The set of function-like nodes that can carry their own `@effects` contract
covers:

- named function declarations
- class methods
- variable-bound function and arrow expressions
- members of a module-scope `const` object literal, when the member has an
  identifier name — `const handlers = { read() { … } }` gives `read` the id
  `handlers.read`, the same declaration-path notation a class method uses

A call inside any other function-like node — a getter/setter, an
object-literal member the notation cannot name, an anonymous `export default`
function, a nested function declaration, an inline callback argument, or
anything else with no extracted ancestor such as a class constructor — is still
walked, and its effects are attributed to the nearest enclosing *extracted*
function. Such a call is invisible only when no extracted ancestor exists.

The identifier-name restriction is not arbitrary. A declaration path is
`"."`-joined, so a computed, string, or numeric key has no spelling that
survives it: `{ "a.b": … }` would be indistinguishable from nesting. The same
rule already limits class-method extraction.

`ambit check --coverage` reports these nodes as "skipped", broken down by
kind: `getter-setter`, `object-literal-method`, `anonymous-default-export`,
`callback-argument`, `nested-function`, and a residual `other`. "Skipped"
means the node cannot declare a contract of its own — not that its effects go
unseen. `object-literal-method` is now narrower than the kind's name suggests:
it covers members of the literals Call resolution above rules out — a
non-identifier key, a `let` binding, a spread, a nested literal, or a literal
declared inside a function body or passed inline as an argument.

Writing a contract on a skipped node is reported as `AMB-E003` rather than
ignored — see `docs/diagnostics/README.md`.

Carrying a contract and being reachable as a call target are gated by the same
rule for object-literal members, so those two lists coincide there. They still
differ elsewhere: a call through a parameter-typed receiver cannot be followed
even when the member it would reach is extracted and declares a contract, and
an inline callback argument's calls are attributed to its enclosing function
even though the callback itself can declare nothing.

## Reading `--coverage`

Ambit run against its own `src/` (2026-09, four functions declaring
`@effects`):

```console
$ node src/cli/main.ts check src --coverage
warning: extractProject declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:37)
warning: loadProjectConfig declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:108)
warning: collectTsFiles declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:155)
warning: main declares fs_read but calls something that could not be resolved (cli/main.ts:24)
files=10 functions=74 declared=4
unknown-rate=66.2% (49/74 functions)
skipped=30 (callback-argument=27, nested-function=3)
call-sites: total=365 resolved=98 stub=2 pure=89 unresolved=176
unresolved-by-reason: builtin-method=38, external-module=135, unresolved-symbol=3
top-unresolved-names: Array.push=21, typescript.isIdentifier=11, Map.set=9, ...
```

- `unknown-rate` — the share of extracted functions whose effects could not be
  fully determined.
- `skipped` — function-like nodes that cannot carry a contract, by kind (see
  above).
- `unresolved-by-reason` and `top-unresolved-names` are the signal for what to
  stub next. `Array.push` and `Map.set` dominating the list here reflects the
  mutating-method exclusion described above.
- `top-unresolved-names` lists only calls a textual name could be built for,
  and only the ten most frequent. An unresolved call with no name — a property
  access on anything but an import binding — raises the `unresolved-symbol`
  count and appears nowhere else, so this list is not a complete picture of
  what is unresolved. The three counted here are all calls to a nested function
  (named `visitTop`, below the top ten).

The summary line (`files= functions= declared=`) is printed on every run, with
or without `--coverage`, so a check that analyzed nothing is never
indistinguishable from a check that found no violations.

## Backend

The current analysis backend (`src/checker/backend/legacy-ts.ts`) is a
connection layer over the TypeScript compiler API, treated as replaceable
until the validation gate in DESIGN.md §3.5 passes. No performance numbers
are claimed for it.
