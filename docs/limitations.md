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

25 entries — `fetch` plus Node.js builtins — producing only `network`,
`fs_read`, `fs_write`, and `process`. No bundled stub produces `db_read`,
`db_write`, `llm`, or `env`; those effects enter the analysis only when
something declares them explicitly. A `pure` function calling a database
driver therefore reports `unknown`, not a violation.

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

## Reading `--coverage`

Ambit run against its own `src/` (2026-09, no `@effects` declared in this
repo yet):

```console
$ node src/cli/main.ts check src --coverage
files=10 functions=66 declared=0
unknown-rate=63.6% (42/66 functions)
skipped=29 (callback-argument=26, nested-function=3)
call-sites: total=306 resolved=83 stub=0 pure=84 unresolved=139
unresolved-by-reason: builtin-method=33, external-module=102, unresolved-symbol=4
top-unresolved-names: Array.push=17, Map.set=9, Set.add=3, visitTop=3, ...
```

- `unknown-rate` — the share of extracted functions whose effects could not be
  fully determined.
- `skipped` — function-like nodes that cannot carry a contract, by kind (see
  above).
- `unresolved-by-reason` and `top-unresolved-names` are the signal for what to
  stub next. `Array.push` and `Map.set` dominating the list here reflects the
  mutating-method exclusion described above.

The summary line (`files= functions= declared=`) is printed on every run, with
or without `--coverage`, so a check that analyzed nothing is never
indistinguishable from a check that found no violations.

## Backend

The current analysis backend (`src/checker/backend/legacy-ts.ts`) is a
connection layer over the TypeScript compiler API, treated as replaceable
until the validation gate in DESIGN.md §3.5 passes. No performance numbers
are claimed for it.
