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
backend extracts: a named function declaration, a method of a named class, or a
variable-bound function or arrow expression. TypeScript may resolve the callee
perfectly well and the call still not be followed, because the declaration it
lands on is not in that set:

- an object-literal property or method — `handlers.read()` where `handlers` is
  an object literal, whether the property holds a named function
  (`{ read: readIt }`) or is written as a method (`{ read() { … } }`), and
  whether or not the literal carries a type annotation
- an interface or type-alias member signature — the same call through a value
  whose static type declares the member
- a nested function declaration — one declared inside another function's body

A call to a class instance method (`client.read()`) *is* resolved; the receiver
being a property access is not what breaks resolution.

The cost is that a contract on the target does not reach the caller. Ambit's
own `legacyTsBackend.extractProject` is a declared `@effects fs_read` function
reached through an object literal, so its declaration does not propagate to
`main` — the call contributes `unknown` there instead.

This does not weaken the "unknown stays unknown" property: such a call is
reported as unresolved, becomes `unknown` in the enclosing function, and raises
`AMB-W001` if that function declares a contract. All of these are counted under
`unresolved-symbol` in `--coverage`. The two property-access forms are counted
without a name, because a name is only built for a bare identifier or a
property access on an import binding — see Reading `--coverage` below.

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

A call inside any other function-like node — a getter/setter, an
object-literal method, an anonymous `export default` function, a nested
function declaration, an inline callback argument, or anything else with no
extracted ancestor such as a class constructor — is still walked, and its
effects are attributed to the nearest enclosing *extracted* function. Such a
call is invisible only when no extracted ancestor exists.

`ambit check --coverage` reports these nodes as "skipped", broken down by
kind: `getter-setter`, `object-literal-method`, `anonymous-default-export`,
`callback-argument`, `nested-function`, and a residual `other`. "Skipped"
means the node cannot declare a contract of its own — not that its effects go
unseen.

Not carrying a contract and not being reachable as a call target are two
separate limits. They coincide for `object-literal-method` and
`nested-function`, which are also unresolvable as callees (see Call resolution
above), but neither list contains the other: an interface member signature
blocks resolution without being a skipped node at all.

## Reading `--coverage`

Ambit run against its own `src/` (2026-09, four functions declaring
`@effects`):

```console
$ node src/cli/main.ts check src --coverage
warning: extractProject declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:36)
warning: loadProjectConfig declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:104)
warning: collectTsFiles declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:151)
warning: main declares fs_read but calls something that could not be resolved (cli/main.ts:23)
files=10 functions=67 declared=4
unknown-rate=64.2% (43/67 functions)
skipped=29 (callback-argument=26, nested-function=3)
call-sites: total=311 resolved=84 stub=2 pure=84 unresolved=141
unresolved-by-reason: builtin-method=33, external-module=104, unresolved-symbol=4
top-unresolved-names: Array.push=17, Map.set=9, typescript.forEachChild=6, ...
```

- `unknown-rate` — the share of extracted functions whose effects could not be
  fully determined.
- `skipped` — function-like nodes that cannot carry a contract, by kind (see
  above).
- `unresolved-by-reason` and `top-unresolved-names` are the signal for what to
  stub next. `Array.push` and `Map.set` dominating the list here reflects the
  mutating-method exclusion described above.
- `top-unresolved-names` lists only calls a textual name could be built for,
  and only the ten most frequent. An unresolved call with no name — the
  property-access forms under Call resolution above — raises the
  `unresolved-symbol` count and appears nowhere else, so this list is not a
  complete picture of what is unresolved. The four counted here are three calls
  to a nested function (named `visitTop`, below the top ten) plus one through
  an object literal (unnamed).

The summary line (`files= functions= declared=`) is printed on every run, with
or without `--coverage`, so a check that analyzed nothing is never
indistinguishable from a check that found no violations.

## Backend

The current analysis backend (`src/checker/backend/legacy-ts.ts`) is a
connection layer over the TypeScript compiler API, treated as replaceable
until the validation gate in DESIGN.md §3.5 passes. No performance numbers
are claimed for it.
