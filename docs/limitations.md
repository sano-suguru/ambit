# Known limitations

Implementation status of `ambit check` — what the analysis actually sees
today, and where it stops. This file records current behavior, not design
intent; the specification is [DESIGN.md](DESIGN.md), and design-level open
questions live in its §12 (未解決の問題).

Ambit is experimental. Expect this file to shrink as the analysis grows.

## Contract tags

`@effects`, `@capabilities`, `@budget`, `@entrypoint`, and `@boundary` are all
parsed. `@effects` and `@capabilities` are checked statically; `@budget` is
validated but only `timeMs` is enforced, at runtime, through `withAmbit`.

The `@capabilities` check has two halves (DESIGN.md §4.4's 二重強制):

- **caller → callee narrowing**, across undeclared functions;
- **a literal target** — an `http:<method>:<host>` read from a literal URL, or
  from a template literal whose static head already ends the authority — which
  must fall inside what the function was granted (`AMB-E009`).

A URL the source does not fix produces no comparable requirement. It is
reported as `AMB-W003` naming the runtime as the place it is matched, never
passed over. No target is derived for any other operation: DESIGN.md §4.4 is
explicit that hooking a database client does not amount to deciding
table-level permission for arbitrary SQL, so no `db:` capability is read out
of a statement.

A `withAmbit(spec, handler)` is compared with the handler's `@capabilities`
when the spec's array is literal and the handler is declared in the same file
(`AMB-E010`). Anything else — a list built at runtime, a handler from another
module, a handler with no contract — is reported as `AMB-W004`. The comparison
is on the source: matching a contract to the handler that actually runs after
a build or a bundler is DESIGN.md §12's 「契約とハンドラの対応付け」, still
open.

Runtime enforcement covers `globalThis.fetch` and `@budget timeMs` only.

## Commands and flags

`ambit check` and `ambit init` are implemented, with `--format json`,
`--coverage`, and `--strict`. `ambit run`, `ambit agent`, `ambit stubs`, and
`ambit sbom` are planned, not built.

`ambit init` proposes `@effects` JSDoc. It writes no `ambit.config.ts` —
out-of-code contracts (DESIGN.md §4.1) are not implemented, so there is no
config for it to write.

## Effect inference

Effects are inferred from four bundled tables.

### The stub table (`src/stubs/node-builtins.ts`)

52 entries — `fetch`, `undici`'s `fetch`, plus Node.js builtins — producing
`network`, `fs_read`, `fs_write`, and `process`.

Matching is import-shape sensitive. Lookup keys are built from the *module
specifier text* plus the imported property/export name, so:

- `import * as fs from "node:fs"; fs.writeFileSync(...)` is recognized
- `import fs from "node:fs"; fs.writeFileSync(...)` is recognized
- `import { writeFileSync } from "node:fs"; writeFileSync(...)` is recognized
  (a local `as` alias doesn't affect matching — the imported name is used)
- a binding re-exported through one or more barrel files is followed to the
  module that owns it, so `import { readFileSync } from "./lib/index.ts"` is
  still `node:fs.readFileSync`

The re-export walk takes the deepest **bare** specifier it passes through, not
simply the deepest one: a package's own types re-export internally
(`export { helper } from "./internal.js"`), and a path inside a package means
nothing outside it. A binding reached by destructuring a *value*
(`const { readFile } = fs`) is not followed at all.

### The database and LLM client table (`src/stubs/data-clients.ts`)

35 rules covering `pg`, `mysql2`, `@prisma/client`, `openai`, and
`@anthropic-ai/sdk`, producing `db_read`, `db_write`, and `llm`. Keys are the
module specifier the client's class was imported from, the class name, and the
property path written at the call site — `pg.Pool.query`,
`@prisma/client.PrismaClient.user.findMany`,
`openai.OpenAI.chat.completions.create`. Every part comes from the project's
own source, so a locally written `declare module "pg"` and an installed `pg`
produce the same key.

Two limits follow from that:

- The receiver must be a `const` whose initializer is `new <ImportedClass>(…)`,
  followed through imports and re-exports. A client held in a class field,
  bound with `let`, or returned by a factory is not matched and reports
  `unknown`.
- Only these five packages are covered. Drizzle, MongoDB, Redis, an S3 client,
  a queue client — all `unknown`.

`pg`'s and `mysql2`'s `query`/`execute` take a statement whose direction is not
always fixed by the source. A literal statement (or a template literal whose
static head reaches the first keyword) is classified by that keyword; anything
else contributes **both** `db_read` and `db_write`. The cost is real: a
read-only function that builds its statement dynamically has to declare
`db_write` too. The alternative would let a generated `UPDATE` pass a
`@effects db_read` contract. DESIGN.md §4.2 records the decision.

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

A method on a database or LLM client is a separate path: it is never followed
to a declaration (the declaration is in a `.d.ts`), it is *named* from the
receiver's origin and matched against the client table above. A method on any
other value reached the same way — `(await fetch(url)).json()`, an SDK type
Ambit ships no rules for — gets no name and stays `unknown`. Where that
declaration lives is reported as the unresolved reason: `builtin-method` for the
compiler's own lib, `external-module` for an installed package, and
`ambient-declaration` for a `.d.ts` the project wrote itself.

**This is not soundness.** `const` freezes the binding, not the properties, so
`handlers.read = other` still defeats it. Resolving a class instance method
rests on exactly the same assumption; following the value adds no new one, and
neither is a guarantee.

An unfollowed call keeps the "unknown stays unknown" property: it is reported as
unresolved, becomes `unknown` in the enclosing function, and raises `AMB-W001`
if that function declares a contract. It is counted under `unresolved-symbol` in
`--coverage` — or under the more specific reason the callee's own declaration
gives (`builtin-method`, `external-module`, `ambient-declaration`). It is
counted *without a name* unless one could be built, and a name is only built
for a bare identifier, or a property access whose receiver traces back to an
import or to a `const` constructed from an imported class. A call through a
parameter, a class field, or a `let` gets no name and appears nowhere but the
reason counts. See Reading `--coverage` below.

### Higher-order functions

Inferring a callback's effects from the argument passed at the call site is
not implemented. A call through a callback parameter falls back to `unknown`.

### `new X(...)`

Construction is part of the call graph. Every class is indexed under the
declaration path `Class.constructor`, and a construction resolves to it:

- `new X(...)` on a project class, whether or not the class writes a
  constructor
- `super(...)`, and the implicit base call a derived class makes when it
  writes no constructor of its own
- a class's property initializers and its constructor's parameter defaults,
  which run as part of the same construction and are attributed to the same
  `Class.constructor` entry

A construction of a class Ambit cannot name — an anonymous class expression,
or a class declared inside a function body — stays `unresolved`, so the
enclosing function becomes `unknown` rather than silently effect-free.

`new Function(...)` is reported as an `eval`-like unresolved call, as before.

An *external* construction is matched against a bundled constructor table
(`src/stubs/constructors.ts`), keyed in its own namespace so that `URL(...)`
and `new URL(...)` never share an entry. The table is small and split three
ways:

- always effectful: `node:net.Socket`, `node:tls.TLSSocket`,
  `node:http.Agent`, `node:https.Agent`, `WebSocket` (`network`);
  `node:worker_threads.Worker` (`process`)
- effectful only with no arguments: `new Date()` reads the clock (`env`),
  while `new Date(2020, 0, 1)` only converts its arguments
- known effect-free: the standard collections, typed arrays, error types,
  `Promise`, `RegExp`, `URL`, `AbortController`, and similar

Anything not in that table — `new PrismaClient()`, for one — is `unknown`,
not effect-free. Constructing a client is a different question from calling
one: the client table names `prisma.user.findMany()`, and says nothing about
whether `new PrismaClient()` opens a connection. In practice clients are
constructed at module scope, outside any function, where there is no call site
to attribute; construct one inside a function and that function is `unknown`.

`new Promise(namedExecutor)` is also `unknown` rather than effect-free: the
executor runs immediately and its body was never walked, the same rule that
applies to `arr.forEach(handler)`.

A class's own JSDoc is never read as its implicit constructor's contract. A
contract belongs on a declaration, and an implicit constructor has none;
`/** @effects pure */ class C {}` documents the class. Writing a contract tag
there is reported as `AMB-E003` rather than ignored, and `ambit init` reports
such a class with no patch attached — the effects are real, but only writing
an explicit constructor gives them somewhere to be declared.

## `@boundary` and the coverage numbers

A `@boundary` function's body is excluded from propagation, so it leaves the
`unknown` numerator without ever having been checked. `--coverage` therefore
prints `boundary-rate` on the same line as `unknown-rate`, over the same
denominator: the two together are the fraction of functions whose contract is
not backed by an analyzed body. Reading `unknown-rate` alone would show
"declare more boundaries" as an improvement.

For the same reason a boundary's own call sites are left out of the
`call-sites:` and `unresolved-by-reason:` lines. Those measure how well
analysis resolves what it looks at, and a boundary is code it deliberately
does not look at; including it would also pad `top-unresolved-names`, the
"what to stub next" signal, with names no stub would help.

## Function extraction

The set of function-like nodes that can carry their own `@effects` contract
covers:

- named function declarations
- class methods
- variable-bound function and arrow expressions
- a class's construction, under `Class.constructor` — a written constructor
  carries the contract; a class with no constructor has no declaration site
  for one
- members of a module-scope `const` object literal, when the member has an
  identifier name — `const handlers = { read() { … } }` gives `read` the id
  `handlers.read`, the same declaration-path notation a class method uses

A call inside any other function-like node — a getter/setter, an
object-literal member the notation cannot name, an anonymous `export default`
function, a nested function declaration, an inline callback argument, or
anything else with no extracted ancestor — is still walked, and its effects are
attributed to the nearest enclosing *extracted* function. Such a call is
invisible only when no extracted ancestor exists.

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

Ambit run against its own `src/` (2026-09-09, four functions declaring
`@effects`):

```console
$ node src/cli/main.ts check src --coverage
warning: extractProject declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:40)
warning: loadProjectConfig declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:124)
warning: collectTsFiles declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:171)
warning: main declares fs_read but calls something that could not be resolved (cli/main.ts:31)
files=19 functions=163 declared=4
unknown-rate=68.7% (112/163 functions) boundary-rate=0.0% (0/163 functions)
entrypoints=0 (without-capabilities=0)
skipped=74 (callback-argument=66, nested-function=8)
call-sites: total=851 resolved=243 stub=3 pure=244 unresolved=361
unresolved-by-reason: builtin-method=131, external-module=221, unresolved-symbol=8, callback-parameter=1
top-unresolved-names: Array.push=50, typescript.isIdentifier=17, Map.set=13, ...
```

- `unknown-rate` — the share of extracted functions whose effects could not be
  fully determined.
- `skipped` — function-like nodes that cannot carry a contract, by kind (see
  above).
- `unresolved-by-reason` and `top-unresolved-names` are the signal for what to
  stub next. `Array.push` and `Map.set` dominating the list here reflects the
  mutating-method exclusion described above.
- `top-unresolved-names` lists only calls a textual name could be built for,
  and only the ten most frequent. An unresolved call with no name raises the
  `unresolved-symbol` count and appears nowhere else, so this list is not a
  complete picture of what is unresolved.

This number is not a target that has been met, and it is dominated by
`external-module` — almost entirely calls into the TypeScript compiler API from
the one file meant to be replaceable. DESIGN.md §10's goal of 30% is for an
*adopting team*. `docs/status.md` records that figure separately, measured
against `test/fixtures/realistic-api`, and the two must not be mixed.

The summary line (`files= functions= declared=`) is printed on every run, with
or without `--coverage`, so a check that analyzed nothing is never
indistinguishable from a check that found no violations.

## Backend

The current analysis backend (`src/checker/backend/legacy-ts.ts`) is a
connection layer over the TypeScript compiler API, treated as replaceable
until the validation gate in DESIGN.md §3.5 passes. No performance numbers
are claimed for it.
