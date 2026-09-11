# Analysis limitations, in detail

The AST-level and table-level corner cases of `ambit check`: which call shapes
resolve, which stub keys match, what `--coverage` counts. This is the overflow
of [`docs/limitations.md`](limitations.md), which carries what someone
**deciding whether to adopt Ambit** needs. This file carries what someone
**maintaining the checker** needs.

If you are evaluating Ambit, read `docs/limitations.md` instead. Nothing here
contradicts it; it is the same limits at the level of individual syntax.

It is not shipped in the npm tarball.

### Symbols a config key cannot name

A `contracts` key is `"<file>#<symbol>"`, where `<symbol>` is the checker's
own declaration path. Anything with no stable declaration path cannot be named
— by a config key or by anything else — and stays reported as `AMB-E003` when
a contract is written on it, and counted under `--coverage`'s "skipped":

- an object-literal member with a **computed, string, or numeric key**
  (`{ [KEY]: … }`, `{ "a.b": … }`, `{ 0: … }`) — the path is `"."`-joined, so
  `{ "a.b": … }` would be indistinguishable from nesting
- any member of an object literal the notation cannot reach at all: a nested
  literal, one bound by `let`, one carrying a spread, one declared inside a
  function body, or one passed inline as an argument
- a **callback passed inline as an argument** (`xs.map((x) => …)`)
- a **function declared inside another function**
- a **named `export default`** is *not* in this list — it has its identifier
  name and is named that way; only the anonymous form uses `default`

The reverse case is a config-only namespace: three kinds of declaration have a
path but nowhere to write a comment, so a key is the *only* way to declare
them.

| Declaration | Key | JSDoc |
|---|---|---|
| `get x()` / `set x()`, on a class or a module-scope `const` literal | `Cls.get x` / `Cls.set x` | inert — `AMB-E003` |
| anonymous `export default` | `default` | inert — `AMB-E003` |
| a class with no constructor | `Cls.constructor` | no declaration site at all |

Keeping JSDoc closed on the first two is a decision, not a limit of the
analysis: the comment is syntactically attachable, and DESIGN.md §4.1 (a)
records why it is refused, and
[`docs/open-questions.md`](open-questions.md) records that the asymmetry is open.

### Matching

`<file>` accepts `*` (within one path segment) and `**` (across directories);
`<symbol>` accepts neither. An exact key always beats a glob; two globs
matching one symbol stop the run with exit 2 rather than picking one. An exact
key that matches nothing is `AMB-W006`; a glob that matches nothing is silent,
because a glob covering a directory this run did not check is normal.

The config is found by walking up from the directory passed to `check` /
`init`, stopping after the first directory holding a `package.json` or `.git`.
It is **loaded by importing it**, not by parsing it: a config that throws on
import is exit 2, and a `contracts` object built by an expression rather than
written literally works for matching but has no line a diagnostic can point
at (`AMB-W006` then falls back to the file's first character, and `init
--config` finds no `contracts: {` line to append to).


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

39 rules covering `pg`, `mysql2`, `@prisma/client`, `openai`, and
`@anthropic-ai/sdk`, producing `db_read`, `db_write`, and `llm`.
Keys are the module specifier the client came from, the client type's name, and
the property path written at the call site — `pg.Pool.query`,
`mysql2/promise.Pool.query`, `@prisma/client.PrismaClient.user.findMany`,
`openai.OpenAI.chat.completions.create`. The specifier and the property path
come from the project's own source, so a locally written `declare module "pg"`
and an installed `pg` produce the same key.

Three limits follow from that:

- The receiver must be one a package's own types describe. Three rules name
  one, tried in that order — two that follow the receiver's *origin*, and one
  that reads its *type* when no origin can be followed. The origin rules take a
  `const` whose initializer is one of the two ways a package hands out a
  client:
  - **`new <ImportedClass>(…)`**, followed through imports and re-exports. The
    type's name here is the identifier the source wrote.
  - **a call of an imported function** — `createPool(…)`, and the same through
    one `await` for `await createConnection(…)`. The specifier is the one the
    source wrote (followed through re-exports, and it must be *bare*: no
    bundled table is keyed on a path, so a project-local wrapper around a
    package's factory is not named); the type's name is read off the
    declaration the call's own type resolves to, which must be a class or
    interface in a `.d.ts` other than the compiler's own lib. An anonymous
    return type, a union, a project class in a `.ts`, and anything the default
    lib declares all yield no name. That last exclusion is what keeps a factory
    returning `Map` on the pure-builtin path below rather than turning a call
    proven effect-free into an unresolved one.

  Where neither applies — a class field, a parameter, a `let`, the result of an
  earlier call in a chain — the receiver's **declared type** names it instead,
  as `<package>.<type name>.<property path>`. Every declaration of that type
  has to be a class or interface a package declares: inside a `declare module
  "…"`, which names its own module, or in a `.d.ts` that came from
  `node_modules`, named by the directory it resolved through — the name the
  source would have had to import it under, so an aliased install is named by
  its alias exactly as the origin rules name it (`@types/<pkg>` answers as
  `<pkg>`; `@types/node` is refused, because Node's builtins are already keyed
  from the import specifier). The chain is
  walked toward its root and the root-most named receiver wins, so a delegate
  keeps the client's own key shape —
  `this.prisma.user.findMany()` is `@prisma/client.PrismaClient.user.findMany`.

  A type is weaker evidence than an origin, and the difference is stated rather
  than hidden: it says which package API the call site was type-checked
  against, not which object will answer. A subclass may override the method
  named here — the same gap DESIGN.md §4.2 rule 7 already states for method
  resolution on class instances, and no wider.

  What this rule does **not** name: a receiver whose type this project
  declares (its own interface — §4.2 rule 7 decides those through the value),
  one the compiler's own lib declares (which would take the call off the
  pure-builtin path), an anonymous object type, and an interface merged with a
  namespace — `knex`'s own `Knex` root is one, so `db.select(…)` is unnamed
  while the `from(…)` that follows it is named.
- **A name is not a verdict.** A receiver these rules name is looked up in the
  table and, on a miss, stays `unresolved` exactly as an unnamed one does —
  what changes is that it now appears in `--coverage`'s
  `top-unresolved-names` instead of only in the reason count.
- **For the factory form, half the key is the package's own type name**, and a
  package is free to change it. `mysql2`'s two entry points already differ:
  `mysql2@3.15.3/promise.d.ts` declares `createPool(config): Pool`, which the
  four `mysql2/promise.*` rows cover, while `typings/mysql/index.d.ts` declares
  `createPool(config): BasePool`, which no row covers — so `import { createPool
  } from "mysql2"` (the callback API) is named `mysql2.BasePool.query` and
  stays `unknown`. The `mysql2.Pool.*` rows match a hand-written `declare
  module "mysql2"` that calls the type `Pool`, not the installed package.
  Nothing tells the two apart from a package whose client was never covered:
  both read as an unresolved call with a name.
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

A separate table allowlists default-lib methods reached through a local value
(`set.has(...)`, `arr.map(...)`). These have no import binding for the stub
table to key on, so they are named by their default-lib type and method
(`Set.has`, `Array.map`) in a namespace kept separate from the
module-specifier one. A second, smaller table beside it covers the globals
called as a bare identifier (`Number(x)`, `parseInt(s)`), which do have a
textual name; it is consulted only for a call the backend already resolved
into TypeScript's own default lib, so the name alone never decides.

Which names are in them is decided by measurement — DESIGN.md §4.2's admission
rule, applied to `node scripts/bench-corpus.ts` over `test/corpus/corpus.json`
and to `ambit check --coverage` on Ambit's own source — plus the non-mutating
siblings on each type that measurement surfaced. What is deliberately left out
matters as much:

- Anything that mutates is excluded — `Array.push`, `Array.sort`, `Map.set`,
  `Set.add`. Those live in a separate table, `src/stubs/mutating-builtins.ts`,
  because a name alone does not decide their effect: mutating a value the
  function itself allocated carries none, and mutating anything reachable from
  outside is `state_write` (DESIGN.md §4.2, "Local mutation and `pure`"). What
  counts as "allocated here" is deliberately narrow — a `const` bound to an
  array literal, object literal, or `new` expression inside the function — and
  every other receiver, including a `let` binding nothing reassigns, is
  over-approximated to `state_write`. A `this` is local in two cases only: a
  constructor of a class with no `extends` clause (with `erasableSyntaxOnly`
  there are no parameter properties, so `this.x = x` is the only way to write
  a field), and a function that is the direct operand of `new`. There is no
  alias analysis: a fresh value handed to something else and mutated
  afterwards still reads as local.
- A name that mutates an *argument* rather than its receiver — `Object.assign`,
  `Object.freeze`, `Object.defineProperty`, `Reflect.set` — has its own table,
  and the locality rule is applied to that argument. `Object.assign({}, x)`
  writes into a value the function just allocated and carries nothing;
  `Object.assign(arg, x)` is `state_write`. `Reflect.apply` is not there: it
  runs a function rather than writing into one, and stays `unknown`.
- A name whose effect depends on what the object is backed by — `Body.json`
  and `Response.json`, a `ReadableStream`'s reader and controller,
  `SubtleCrypto` — is left `unknown`. A `Response` body can be a socket.
- `console.log` and its siblings write to a stream DESIGN.md §4.2's effect
  table has no name for, so they are `unknown` rather than `pure`.
- `Date.now()` and `Math.random()` are not in the pure table at all: §4.2 lists
  the clock and randomness under `env`, so they carry that effect
  (`src/stubs/builtin-effects.ts`), exactly as `new Date()` already did.
- A method that can take a callback (`map`, `filter`, `reduce`, …) is settled
  by the callback, not by the method name. `arr.map(x => ...)` is walked and
  its effects attributed to the enclosing function. `arr.map(namedFn)` is
  followed to `namedFn` when that names a declaration the backend extracted,
  and the call carries what `namedFn` carries. Only a reference that reaches
  nothing analyzable — a parameter, a package export, a `.bind()` result — is
  still `unknown` (DESIGN.md §4.2 rule 4). The same holds for a destructive
  method handed a comparator: `arr.sort(cmp)` answers for the receiver by the
  locality rule and for `cmp` by the same rule 4.
- A method that *cannot* call what it is handed (`Array.isArray(fn)`,
  `Number(fn)`) is not refused over a callable argument. Which allowlisted
  members can invoke one is enumerated beside the table, not inferred.

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
for a bare identifier, for a property access whose receiver traces back to an
import or to a `const` constructed from an imported class or holding an
imported factory's result, or — failing all of those — for one whose receiver's
declared type a package declares (see "The database and LLM client table" above
for all three forms and their conditions). A receiver no package type describes
gets no name and appears nowhere but the reason counts. See Reading `--coverage` below.

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

Two more shapes are extracted and propagate, but can only be *declared* from
`ambit.config.ts` (DESIGN.md §4.1 (a)): a `get`/`set` accessor, under
`Cls.get x` / `Cls.set x`, and an anonymous `export default`, under `default`.
The accessor case follows the same reachability rule as the bullet above it —
a class member, or a member of a module-scope `const` object literal — so an
accessor in a literal that rule does not reach is skipped, not extracted. A
contract comment on any of these is still `AMB-E003`; see "`ambit.config.ts`"
above.

A call inside any other function-like node — an object-literal member the
notation cannot name, a nested function declaration, an inline callback
argument, or anything else with no extracted ancestor — is still walked, and
its effects are attributed to the nearest enclosing *extracted* function. Such
a call is invisible only when no extracted ancestor exists.

The identifier-name restriction is not arbitrary. A declaration path is
`"."`-joined, so a computed, string, or numeric key has no spelling that
survives it: `{ "a.b": … }` would be indistinguishable from nesting. The same
rule already limits class-method extraction.

`ambit check --coverage` reports these nodes as "skipped", broken down by
kind: `getter-setter`, `object-literal-method`, `anonymous-default-export`,
`callback-argument`, `nested-function`, `bodyless-declaration`, and a residual
`other`. `bodyless-declaration` is a signature with no code — an overload
signature, an `abstract` member, or a `declare function` in a `.ts` file. An
overload set is one function and it is the implementation, so the signatures
are skipped and the implementation is extracted; a contract on a signature is
`AMB-E003` naming the implementation. The first and
third are narrower than they were: an accessor is extracted when it is a class
member or a member of a module-scope `const` object literal, so `getter-setter`
now counts only accessors in the literals that notation cannot reach (a `let`
binding, a spread, a nested literal, one inside a function body, one passed
inline). `anonymous-default-export` likewise counts only the forms `default`
does not cover. "Skipped"
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
warning: extractProject declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:43)
warning: loadProjectConfig declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:152)
warning: collectTsFiles declares fs_read but calls something that could not be resolved (checker/backend/legacy-ts.ts:199)
warning: main declares fs_read but calls something that could not be resolved (cli/main.ts:37)
files=29 functions=238 declared=4
declared-by: jsdoc=4 config=0
unknown-rate=66.0% (157/238 functions) boundary-rate=0.0% (0/238 functions)
entrypoints=0 (without-capabilities=0)
skipped=109 (callback-argument=91, object-literal-method=3, nested-function=15)
call-sites: total=1287 resolved=406 stub=8 pure=327 mutation=110 unresolved=436
unresolved-by-reason: builtin-method=102, external-module=314, dynamic-import=1, unresolved-symbol=15, callback-parameter=4
top-unresolved-names: typescript.isIdentifier=22, ReadonlyArray.map=13, ...
```

No `bodyless-declaration` appears because `src/` contains no overload
signature, `abstract` member, or `.ts`-file `declare`.

- `unknown-rate` — the share of extracted functions whose effects could not be
  fully determined.
- `mutation` — in-place mutation sites, counted apart from `pure`: a local one
  carries no effect but is not the same evidence as a call proven pure, and an
  escaping one is a `state_write` no stub table produced.
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
the one file meant to be replaceable. `ROADMAP.md`'s goal of 30% is for an
*adopting team*. `docs/status.md` records that figure separately, measured
against `test/fixtures/realistic-api`, and the two must not be mixed.

The summary line (`files= functions= declared=`) is printed on every run, with
or without `--coverage`, so a check that analyzed nothing is never
indistinguishable from a check that found no violations.

