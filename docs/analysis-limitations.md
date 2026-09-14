# Analysis limitations, in detail

The AST-level and table-level corner cases of `ambit check` and `ambit diff`:
which call shapes resolve, which stub keys match, what `--coverage` counts, and
how `diff` matches symbols. This is the detail behind
[`docs/limitations.md`](limitations.md), which carries what someone **deciding
whether to adopt Ambit** needs. This file carries what someone **maintaining the
checker** needs, including the measurements behind the adopter-facing limits.

If you are evaluating Ambit, read `docs/limitations.md` instead. Nothing here
contradicts it; it is the same limits at the level of individual syntax.

It is not shipped in the npm tarball.

## `ambit.config.ts`

### Symbols a config key cannot name

A `contracts` key is `"<file>#<symbol>"`, where `<symbol>` is the checker's own
declaration path. Anything with no stable declaration path cannot be named — by
a config key or by anything else. A contract written on one is reported as
`AMB-E003`, and the node is counted under `--coverage`'s "skipped":

- an object-literal member with a **computed, string, or numeric key**
  (`{ [KEY]: … }`, `{ "a.b": … }`, `{ 0: … }`) — the path is `"."`-joined, so
  `{ "a.b": … }` would be indistinguishable from nesting
- any member of an object literal the notation cannot reach at all: a nested
  literal, one bound by `let`, one carrying a spread, one declared inside a
  function body, or one passed inline as an argument
- a **callback passed inline as an argument** (`xs.map((x) => …)`)
- a **function declared inside another function**

A **named `export default`** is *not* in this list: it has its identifier name
and is named that way. Only the anonymous form uses `default`.

### Declarations only a config key can declare

Three kinds of declaration have a path but nowhere to write a comment, so a key
is the *only* way to declare them.

| Declaration | Key | JSDoc |
|---|---|---|
| `get x()` / `set x()`, on a class or a module-scope `const` literal | `Cls.get x` / `Cls.set x` | inert — `AMB-E003` |
| anonymous `export default` | `default` | inert — `AMB-E003` |
| a class with no constructor | `Cls.constructor` | no declaration site at all |

Keeping JSDoc closed on the first two is a decision, not a limit of the
analysis: the comment is syntactically attachable, DESIGN.md §4.1 (a) records
why it is refused, and [`docs/open-questions.md`](open-questions.md) records that
the asymmetry is open.

### Matching

- **Globs.** `<file>` accepts `*` (within one path segment) and `**` (across
  directories); `<symbol>` accepts neither.
- **Precedence.** An exact key always beats a glob. Two globs matching one
  symbol stop the run with exit 2 rather than picking one.
- **Unmatched keys.** An exact key that matches nothing is `AMB-W006`. A glob
  that matches nothing is silent, because a glob covering a directory this run
  did not check is normal.

### Discovery and loading

- The config is found by walking up from the directory passed to `check` /
  `init`, stopping after the first directory holding a `package.json` or `.git`.
- It is **loaded by importing it**, not by parsing it. A config that throws on
  import is exit 2.
- A `contracts` object built by an expression rather than written literally
  works for matching, but has no line a diagnostic can point at: `AMB-W006`
  falls back to the file's first character, and `init --config` finds no
  `contracts: {` line to append to.
- `init --config` creates no config file: the `defineConfig` import specifier
  depends on how the consumer installed Ambit, and DESIGN.md §5.3 forbids
  emitting a patch that may not apply.

## Contracts on registrations

The `@capabilities` check has two halves (DESIGN.md §4.4's dual enforcement):

- **caller → callee narrowing**, across undeclared functions;
- **a literal target** — an `http:<method>:<host>` read from a literal URL, or
  from a template literal whose static head already ends the authority — which
  must fall inside what the function was granted (`AMB-E009`).

A URL the source does not fix produces no comparable requirement; it is reported
as `AMB-W003`, naming the runtime as the place it is matched, never passed over.
No target is derived for any other operation: DESIGN.md §4.4 is explicit that
hooking a database client does not amount to deciding table-level permission for
arbitrary SQL.

A `withAmbit(spec, handler)`, `ambitHandler(spec, handler, decode)` or
`ambitRoute(spec, handler, decode)` declares the handler's contract when:

- `spec.capabilities` is a literal array, and
- `handler` names a declaration in the same file.

`spec.budget` is the handler's `@budget` under the same conditions,
independently of the capability half. Writing the tag as well is allowed and
checked; a disagreement is `AMB-E010` / `AMB-E011`, an error.

Two cases fall outside that. In both the JSDoc tag is required, `AMB-W004` says
so, and neither is silently treated as `unknown`:

- **a spec Ambit cannot read** — a capability list built at run time, a budget
  that is not an object literal of literal limits;
- **a handler from another module** — the registration names no declaration in
  the file, so there is no summary to attach the declaration to. This is
  [`docs/open-questions.md`](open-questions.md)'s "Mapping contracts to
  handlers" (2), still open.

In `test/fixtures/realistic-api` every registration names a same-file handler;
there is no measurement of how often either case occurs in general code.

## Effect inference

Effects are inferred from four bundled tables.

### The stub table (`src/stubs/node-builtins.ts`)

59 entries — `fetch`, `undici`'s `fetch`, `ky`, plus Node.js builtins —
producing `network`, `fs_read`, `fs_write`, and `process`.

**`ky`** is keyed on its default export, since that is what the package exports
and a default export has no name of its own:

- `ky.default` for the bare call;
- `ky.get` / `ky.post` / `ky.put` / `ky.patch` / `ky.delete` / `ky.head` for the
  request methods;
- `create` and `extend` return a new instance and send nothing, so they have no
  row and stay `unknown`;
- a `KyInstance` *handed* to a function — a class field, a parameter — has no
  row either: measurement surfaced the default-export shape only, and the table
  admits the names measurement surfaces (`src/stubs/data-clients.ts`).

**Matching is import-shape sensitive.** Lookup keys are built from the *module
specifier text* plus the imported property/export name, so:

- `import * as fs from "node:fs"; fs.writeFileSync(...)` is recognized
- `import fs from "node:fs"; fs.writeFileSync(...)` is recognized
- `import { writeFileSync } from "node:fs"; writeFileSync(...)` is recognized
  (a local `as` alias doesn't affect matching — the imported name is used)
- the same three written without the `node:` prefix (`from "fs"`) are
  recognized, and produce the same verdict
- a binding re-exported through one or more barrel files is followed to the
  module that owns it, so `import { readFileSync } from "./lib/index.ts"` is
  still `node:fs.readFileSync`

**Builtin spellings.** The specifier is normalized to the prefixed spelling at
lookup, for the builtins the bundled tables have a row for. Node resolves a bare
builtin specifier to the builtin before it looks at `node_modules`, so the two
spellings cannot be different modules. Nothing else is normalized:

- a builtin no table answers (`os`, `path`) keeps the spelling its source wrote
  in the coverage histogram;
- the *reported* operation is also the spelling the source wrote —
  `fs.writeFileSync`, not `node:fs.writeFileSync`.

**Re-exports.** The re-export walk takes the deepest **bare** specifier it passes
through, not simply the deepest one: a package's own types re-export internally
(`export { helper } from "./internal.js"`), and a path inside a package means
nothing outside it. A binding reached by destructuring a *value*
(`const { readFile } = fs`) is not followed at all.

**`@types/node` and `types`.** A tsconfig with no `types` is read as TypeScript 5
read it — every installed `@types/*` — though the bundled compiler is 6.0.3. An
explicit list is taken as written, so `"types": []` leaves `node:fs` unresolved,
exactly as the project's own `tsc` fails on that import.

### The database and LLM client table (`src/stubs/data-clients.ts`)

49 rules covering `pg`, `mysql2`, `knex`, `@prisma/client`, `openai`, and
`@anthropic-ai/sdk`, producing `db_read`, `db_write`, and `llm`.

**Keys** are the module specifier the client came from, the client type's name,
and the property path written at the call site — `pg.Pool.query`,
`mysql2/promise.Pool.query`, `@prisma/client.PrismaClient.user.findMany`,
`openai.OpenAI.chat.completions.create`. The specifier and the property path come
from the project's own source, so a locally written `declare module "pg"` and an
installed `pg` produce the same key.

#### Naming a receiver

**Rule.** The receiver must be one a package's own types describe. Three rules
name one, tried in this order: two that follow the receiver's *origin*, and one
that reads its *type* when no origin can be followed.

**Origin rule 1 — `new <ImportedClass>(…)`.** A `const` initialized this way,
followed through imports and re-exports. The type's name is the identifier the
source wrote.

**Origin rule 2 — a call of an imported function.** `createPool(…)`, and the same
through one `await` for `await createConnection(…)`.

- The specifier is the one the source wrote, followed through re-exports. It must
  be *bare*: no bundled table is keyed on a path, so a project-local wrapper
  around a package's factory is not named.
- The type's name is read off the declaration the call's own type resolves to,
  which must be a class or interface in a `.d.ts` other than the compiler's own
  lib.
- An anonymous return type, a union, a project class in a `.ts`, and anything the
  default lib declares all yield no name. That last exclusion keeps a factory
  returning `Map` on the pure-builtin path below, rather than turning a call
  proven effect-free into an unresolved one.

**Type rule — the receiver's declared type.** Where neither origin rule applies —
a class field, a parameter, a `let`, the result of an earlier call in a chain —
the receiver's **declared type** names it, as
`<package>.<type name>.<property path>`.

- Every declaration of that type has to be a class or interface a package
  declares: inside a `declare module "…"`, which names its own module, or in a
  `.d.ts` that came from `node_modules`.
- A `.d.ts` from `node_modules` is named by the directory it resolved through —
  the name the source would have had to import it under — so an aliased install
  is named by its alias exactly as the origin rules name it. `@types/<pkg>`
  answers as `<pkg>`; `@types/node` is refused, because Node's builtins are
  already keyed from the import specifier.
- The chain is walked toward its root and the root-most named receiver wins, so a
  delegate keeps the client's own key shape: `this.prisma.user.findMany()` is
  `@prisma/client.PrismaClient.user.findMany`.

**Evidence strength.** A type is weaker evidence than an origin, and the
difference is stated rather than hidden: it says which package API the call site
was type-checked against, not which object will answer. A subclass may override
the method named here — the same gap DESIGN.md §4.2 rule 7 already states for
method resolution on class instances, and no wider.

**Not named by the type rule:**

- a receiver whose type this project declares (its own interface — §4.2 rule 7
  decides those through the value);
- one the compiler's own lib declares (which would take the call off the
  pure-builtin path);
- an anonymous object type;
- an interface merged with a namespace — `knex`'s own `Knex` root is one, so
  `db.select(…)` is unnamed while the `from(…)` that follows it is named.

#### Consequences

- **A name is not a verdict.** A receiver these rules name is looked up in the
  table and, on a miss, stays `unresolved` exactly as an unnamed one does. What
  changes is that it now appears in `--coverage`'s `top-unresolved-names` instead
  of only in the reason count.
- **For the factory form, half the key is the package's own type name**, and a
  package is free to change it. `mysql2`'s two entry points already differ:
  - `mysql2@3.15.3/promise.d.ts` declares `createPool(config): Pool`, which the
    four `mysql2/promise.*` rows cover;
  - `typings/mysql/index.d.ts` declares `createPool(config): BasePool`, which no
    row covers — so `import { createPool } from "mysql2"` (the callback API) is
    named `mysql2.BasePool.query` and stays `unknown`;
  - the `mysql2.Pool.*` rows match a hand-written `declare module "mysql2"` that
    calls the type `Pool`, not the installed package.

  Nothing tells the two apart from a package whose client was never covered: both
  read as an unresolved call with a name.
- Only these six packages are covered. Drizzle, MongoDB, Redis, an S3 client,
  a queue client — all `unknown`.

#### Statement direction

`pg`'s and `mysql2`'s `query`/`execute` take a statement whose direction is not
always fixed by the source.

- A literal statement, or a template literal whose static head reaches the first
  keyword, is classified by that keyword.
- Anything else contributes **both** `db_read` and `db_write`.

The cost is real: a read-only function that builds its statement dynamically has
to declare `db_write` too. The alternative would let a generated `UPDATE` pass a
`@effects db_read` contract. DESIGN.md §4.2 records the decision.

### The pure built-ins allowlist (`src/stubs/pure-builtins.ts`)

A separate table allowlists default-lib methods reached through a local value
(`set.has(...)`, `arr.map(...)`). These have no import binding for the stub table
to key on, so they are named by their default-lib type and method (`Set.has`,
`Array.map`) in a namespace kept separate from the module-specifier one.

A second, smaller table beside it covers the globals called as a bare identifier
(`Number(x)`, `parseInt(s)`), which do have a textual name. It is consulted only
for a call the backend already resolved into TypeScript's own default lib, so
the name alone never decides.

**Admission.** Which names are in them is decided by measurement — DESIGN.md
§4.2's admission rule, applied to `node scripts/bench-corpus.ts` over
`test/corpus/corpus.json` and to `ambit check --coverage` on Ambit's own source —
plus the non-mutating siblings on each type that measurement surfaced.

**Deliberately left out:**

- **Anything that mutates** — `Array.push`, `Array.sort`, `Map.set`, `Set.add`.
  Those live in a separate table, `src/stubs/mutating-builtins.ts`, because a
  name alone does not decide their effect: mutating a value the function itself
  allocated carries none, and mutating anything reachable from outside is
  `state_write` (DESIGN.md §4.2, "Local mutation and `pure`").
  - *Allocated here* is deliberately narrow: a `const` bound to an array
    literal, object literal, or `new` expression inside the function. Every
    other receiver, including a `let` binding nothing reassigns, is
    over-approximated to `state_write`.
  - A `this` is local in two cases only: a constructor of a class with no
    `extends` clause (with `erasableSyntaxOnly` there are no parameter
    properties, so `this.x = x` is the only way to write a field), and a
    function that is the direct operand of `new`.
  - There is no alias analysis: a fresh value handed to something else and
    mutated afterwards still reads as local.
- **A name that mutates an *argument* rather than its receiver** —
  `Object.assign`, `Object.freeze`, `Object.defineProperty`, `Reflect.set` — has
  its own table, and the locality rule is applied to that argument.
  `Object.assign({}, x)` writes into a value the function just allocated and
  carries nothing; `Object.assign(arg, x)` is `state_write`. `Reflect.apply` is
  not there: it runs a function rather than writing into one, and stays
  `unknown`.
- **A name whose effect depends on what the object is backed by** —
  `Body.json` and `Response.json`, a `ReadableStream`'s reader and controller,
  `SubtleCrypto` — is left `unknown`. A `Response` body can be a socket.
- **`console.log` and its siblings** write to a stream DESIGN.md §4.2's effect
  table has no name for, so they are `unknown` rather than `pure`.
- **`Date.now()` and `Math.random()`** are not in the pure table at all: §4.2
  lists the clock and randomness under `env`, so they carry that effect
  (`src/stubs/builtin-effects.ts`), exactly as `new Date()` already did.

**Callbacks.**

- A method that can take a callback (`map`, `filter`, `reduce`, …) is settled by
  the callback, not by the method name. `arr.map(x => ...)` is walked and its
  effects attributed to the enclosing function.
- `arr.map(namedFn)` is followed to `namedFn` when that names a declaration the
  backend extracted, and the call carries what `namedFn` carries.
- Only a reference that reaches nothing analyzable — a parameter, a package
  export, a `.bind()` result — is still `unknown` (DESIGN.md §4.2 rule 4).
- The same holds for a destructive method handed a comparator: `arr.sort(cmp)`
  answers for the receiver by the locality rule and for `cmp` by the same rule 4.
- A method that *cannot* call what it is handed (`Array.isArray(fn)`,
  `Number(fn)`) is not refused over a callable argument. Which allowlisted
  members can invoke one is enumerated beside the table, not inferred.

### Call resolution

A call is followed to its target only when the callee's declaration is one the
backend extracts. `handlers.read()` is resolved through the receiver's *value*
rather than its static type, so a type annotation on `handlers` does not change
the outcome — what matters is whether one object literal certainly stands behind
the receiver.

**Followed:**

- `const handlers = { read() { … } }` and `{ read: () => … }` — the member is
  extracted and has its own contract
- `const handlers = { read: readIt }` and `{ readIt }` — the member names an
  already-extracted function, and the call resolves to that function
- the same with `satisfies` or `as const`, which assert a type without changing
  the value
- a class instance method (`client.read()`)

**Not followed:**

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

**Client methods.** A method on a database or LLM client is a separate path: it
is never followed to a declaration (the declaration is in a `.d.ts`); it is
*named* from the receiver and matched against the client table above. A method
on any other value reached the same way — `(await fetch(url)).json()`, an SDK
type Ambit ships no rules for — gets no name and stays `unknown`. Where that
declaration lives is reported as the unresolved reason:

- `builtin-method` for the compiler's own lib
- `external-module` for an installed package
- `ambient-declaration` for a `.d.ts` the project wrote itself

**This is not soundness.** `const` freezes the binding, not the properties, so
`handlers.read = other` still defeats it. Resolving a class instance method rests
on exactly the same assumption; following the value adds no new one, and neither
is a guarantee.

**An unfollowed call** keeps the "unknown stays unknown" property:

- it is reported as unresolved, becomes `unknown` in the enclosing function, and
  raises `AMB-W001` if that function declares a contract;
- it is counted under `unresolved-symbol` in `--coverage`, or under the more
  specific reason the callee's own declaration gives (`builtin-method`,
  `external-module`, `ambient-declaration`);
- it is counted *without a name* unless one could be built.

A name is only built for:

- a bare identifier that is not an import binding following to no declaration
  (an `import-binding` call has only its local spelling, which does not say which
  export it names);
- a property access whose receiver traces back to an import, or to a `const`
  constructed from an imported class or holding an imported factory's result;
- failing all of those, a property access whose receiver's declared type a
  package declares.

"Naming a receiver" above has all three forms and their conditions. A receiver no
package type describes gets no name and appears nowhere but the reason counts.
See Reading `--coverage` below.

### Higher-order functions

Inferring a callback's effects from the argument passed at the call site is not
implemented. A call through a callback parameter falls back to `unknown`.

### `new X(...)`

Construction is part of the call graph. Every class is indexed under the
declaration path `Class.constructor`, and a construction resolves to it:

- `new X(...)` on a project class, whether or not the class writes a constructor
- `super(...)`, and the implicit base call a derived class makes when it writes
  no constructor of its own
- a class's property initializers and its constructor's parameter defaults,
  which run as part of the same construction and are attributed to the same
  `Class.constructor` entry

A construction of a class Ambit cannot name — an anonymous class expression, or a
class declared inside a function body — stays `unresolved`, so the enclosing
function becomes `unknown` rather than silently effect-free.

`new Function(...)` is reported as an `eval`-like unresolved call, as before.

**External constructions** are matched against a bundled constructor table
(`src/stubs/constructors.ts`), keyed in its own namespace so that `URL(...)` and
`new URL(...)` never share an entry. The table is small and split three ways:

- always effectful: `node:net.Socket`, `node:tls.TLSSocket`, `node:http.Agent`,
  `node:https.Agent`, `WebSocket` (`network`); `node:worker_threads.Worker`
  (`process`)
- effectful only with no arguments: `new Date()` reads the clock (`env`), while
  `new Date(2020, 0, 1)` only converts its arguments
- known effect-free: the standard collections, typed arrays, error types,
  `Promise`, `RegExp`, `URL`, `AbortController`, and similar

**Not in the table means `unknown`.** `new PrismaClient()`, for one, is `unknown`,
not effect-free. Constructing a client is a different question from calling one:
the client table names `prisma.user.findMany()`, and says nothing about whether
`new PrismaClient()` opens a connection. In practice clients are constructed at
module scope, outside any function, where there is no call site to attribute;
construct one inside a function and that function is `unknown`.

`new Promise(namedExecutor)` is also `unknown` rather than effect-free: the
executor runs immediately and its body was never walked, the same rule that
applies to `arr.forEach(handler)`.

**A class's own JSDoc is never read as its implicit constructor's contract.** A
contract belongs on a declaration, and an implicit constructor has none;
`/** @effects pure */ class C {}` documents the class. Writing a contract tag
there is reported as `AMB-E003` rather than ignored, and `ambit init` reports such
a class with no patch attached — the effects are real, but only writing an
explicit constructor gives them somewhere to be declared.

## `@boundary` and the coverage numbers

- A `@boundary` function's body is excluded from propagation, so it leaves the
  `unknown` numerator without ever having been checked. `--coverage` therefore
  prints `boundary-rate` on the same line as `unknown-rate`, over the same
  denominator: the two together are the fraction of functions whose contract is
  not backed by an analyzed body. Reading `unknown-rate` alone would show
  "declare more boundaries" as an improvement.
- For the same reason a boundary's own call sites are left out of the
  `call-sites:` and `unresolved-by-reason:` lines. Those measure how well
  analysis resolves what it looks at, and a boundary is code it deliberately does
  not look at; including it would also pad `top-unresolved-names`, the "what to
  stub next" signal, with names no stub would help.

## Function extraction

### What can carry a contract

The set of function-like nodes that can carry their own `@effects` contract:

- named function declarations
- class methods
- variable-bound function and arrow expressions
- a class's construction, under `Class.constructor` — a written constructor
  carries the contract; a class with no constructor has no declaration site for
  one
- members of a module-scope `const` object literal, when the member has an
  identifier name — `const handlers = { read() { … } }` gives `read` the id
  `handlers.read`, the same declaration-path notation a class method uses
- members of a namespace, under the namespace's name — `namespace sql { export
  function param() { … } }` gives `param` the id `sql.param`

The identifier-name restriction is not arbitrary. A declaration path is
`"."`-joined, so a computed, string, or numeric key has no spelling that survives
it: `{ "a.b": … }` would be indistinguishable from nesting. The same rule already
limits class-method extraction.

### Static members and id collisions

- A `static` member's segment carries the marker: `Class.static run`, and
  `Class.static get total` for a static accessor.
- A class may declare `run()` and `static run()` at once and they are two
  different functions, so one declaration path for both would break the
  one-to-one rule DESIGN.md §4.1 calls "a termination requirement as well as a
  notation" — `propagate` would never converge. The marker is unconditional, so
  adding an instance member never renames the static one.
- If two declarations do end up sharing an id, the run stops with exit 2 and an
  error naming it rather than hanging; that is a gap in these declaration paths
  and is worth reporting.
- **One shape is known to remain:** a class and a namespace of the same name
  merged in one file — `class Foo { bar() {} }` beside `namespace Foo { export
  function bar() {} }` — gives both members the path `Foo.bar`. Neither the three
  measured third-party backends nor the corpus has it, so it has never fired.

### Extracted, but declarable only from config

A `get`/`set` accessor, under `Cls.get x` / `Cls.set x`, and an anonymous `export
default`, under `default`, are extracted and propagate, but can only be
*declared* from `ambit.config.ts` (DESIGN.md §4.1 (a)).

- The accessor case follows the same reachability rule as object-literal
  members: a class member, or a member of a module-scope `const` object literal.
  An accessor in a literal that rule does not reach is skipped, not extracted.
- A contract comment on any of these is still `AMB-E003`; see "`ambit.config.ts`"
  above.

### Extracted, and declarable from nowhere: the inline-callback owner

A file's inline callbacks are extracted under the single segment
`<inline callbacks>` (DESIGN.md §4.1 (a)).

- **What it owns:** every function expression written directly as a call
  argument with no function-like or class-like ancestor — the module-scope
  `router.post("x", async (ctx) => { … })` — collectively, one entry per file.
- **Declaring it:** a contract comment on one of the callbacks is `AMB-E003` as
  before, and an `ambit.config.ts` key naming the owner is reported as matching
  no symbol.
- **Why one entry per file:** an anonymous sibling has no name to be told apart
  by. What replaces the name is that §6.3 compares the owner's authority as a
  multiset over the bodies it owns, so two handlers holding the same effect are
  two holders and a third is an increase.
- **Walking:** each callback is still walked as *itself*, not as a body of the
  file, so a mutation that escapes the callback is not mistaken for a local one.

How `diff` reports this owner is under "How `ambit diff` compares" below.

### Calls with no extracted function around them

A call inside any other function-like node — an object-literal member the
notation cannot name, a nested function declaration, an inline callback inside
one of the above, or anything else with no extracted ancestor — is still walked,
and its effects are attributed to the nearest enclosing *extracted* function or
inline-callback owner. Such a call is invisible only when neither exists. One
shape where neither does is a module-scope IIFE — `(async () => { await fetch(…)
})()` — whose function is not in argument position; its calls are attributed to
nothing, as every top-level statement's still are.

### Skipped kinds in `--coverage`

`ambit check --coverage` reports the nodes that cannot declare a contract as
"skipped", broken down by kind. "Skipped" means the node cannot declare a
contract of its own — not that its effects go unseen.

| Kind | What it counts |
|---|---|
| `getter-setter` | only accessors in the literals the notation cannot reach (a `let` binding, a spread, a nested literal, one inside a function body, one passed inline); class-member accessors and module-scope `const` literal accessors are extracted |
| `object-literal-method` | members of the literals Call resolution above rules out — a non-identifier key, a `let` binding, a spread, a nested literal, or a literal declared inside a function body or passed inline as an argument |
| `anonymous-default-export` | only the forms `default` does not cover |
| `callback-argument` | callbacks passed inline as an argument |
| `nested-function` | functions declared inside another function |
| `bodyless-declaration` | a signature with no code — an overload signature, an `abstract` member, or a `declare function` in a `.ts` file. An overload set is one function and it is the implementation, so the signatures are skipped and the implementation is extracted; a contract on a signature is `AMB-E003` naming the implementation |
| `other` | the residual |

Writing a contract on a skipped node is reported as `AMB-E003` rather than
ignored — see `docs/diagnostics/README.md`.

### Carrying a contract vs being a call target

Carrying a contract and being reachable as a call target are gated by the same
rule for object-literal members, so those two lists coincide there. They still
differ elsewhere:

- a call through a parameter-typed receiver cannot be followed even when the
  member it would reach is extracted and declares a contract;
- an inline callback argument's calls are attributed to its enclosing function,
  or to its file's inline-callback owner, even though the callback itself can
  declare nothing.

## How `ambit diff` compares

The adopter-facing consequences are in
[`docs/limitations.md`](limitations.md#what-ambit-diff-can-and-cannot-see); this
is the mechanism and the measurements behind them.

### Why `diff` exists beside `check`

`check` validates the code against whatever contract is currently written, so
editing the tag along with the code — including by applying the `widen` fix
Ambit itself offers — makes it green again. Measured on `test/fixtures/accident`,
changing `priceOrder` from `@effects pure` to `@effects network` takes
`check test/fixtures/accident` from exit 1 to exit 0, while
`diff HEAD test/fixtures/accident` exits 1 and names the hop that carried the
authority.

### The inline-callback owner

- **Comparison.** The owner's authority is compared as a multiset over its bodies
  (§6.3), so a `fetch(…)` added inside one handler is an increase even when a
  sibling handler in the same file already reaches the network.
- **Position.** The entry's own position is the start of the file. The witness
  path names *a* body holding the authority, which on a count increase need not
  be the one that changed. The `operation:` line is the position of a real call
  to the operation.
- **Movement between handlers.** `router.post("/admin", …)` losing `network`
  while `router.post("/public", …)` gains it leaves the total at one, and the two
  sequences are the two a plain reorder produces. The same holds for an
  operation the analysis could not read moving between them. §6.4's third shape
  reports that the bodies cannot be matched, and `--strict` fails on it. A plain
  reorder is reported the same way, because it is the other reading of the same
  evidence.
- **Authority already held.** Authority is a set per body, so a body that gains
  an authority it already held is silent, and a *named* function reports nothing
  for it either — measured on `outline/outline@35dd15b9`, where extracting the
  same handler to a named `const` first also reports nothing
  ([2026-09-11](measurements/2026-09-11-inline-callback-owner.md), E6c).
- **`--strict`.** Bodies that were never walked before the owner existed are now
  analyzed, and most of them reach calls no stub table covers. On all three
  third-party subjects, adding one `expect(…)` line to a test file takes
  `--strict` from exit 0 to exit 1 as a §6.4 report. Default `ambit diff` is
  unaffected (exit 0).

### Symbol identity and renames

- A symbol id is `<path relative to the checked directory>#<declaration path>`
  (DESIGN.md §5.3), so `src/tax.ts#calculateTax` and
  `src/pricing/tax.ts#calculateTax` are two different symbols.
- `ambit diff` re-expresses the base side's ids under the head side's paths for
  every rename `git diff --find-renames` reports, so an ordinary file move is
  compared against itself and needs no approval.
- **Left over, each costing one approval line:**
  - a function renamed *within* a file — git reports no rename, and matching two
    declaration paths inside one file would be a guess about identity;
  - a move git does not detect — because the edit that came with it fell under
    its similarity threshold, or because the new path is not tracked yet, since
    rename detection compares the index and the working tree against the base
    commit.
- Both over-report rather than under-report, which is the direction §3.4
  requires.

### `unknown` and `--strict`

- **Gaining `unknown` is not an increase.** A call the analysis cannot resolve
  means the effect set may be incomplete (DESIGN.md §4.3); it does not mean the
  function acquired anything. `diff` reports both of §6.4's first two shapes — a
  symbol that stopped being resolved, and an `unknown` symbol whose body gained
  an unresolvable operation — in their own section at exit 0.
- **Closing a `--strict` report.** The three ways to reduce `unknown` (§4.3) are
  a verifiable declaration, a stub, or `@boundary`. A stub for a third-party
  package is Ambit's to write: `ambit.config.ts` declares contracts for symbols
  in the tree being checked, named `file#path`, and has no notation for a symbol
  inside `node_modules`. So for a client no bundled table covers — `axios` and
  `got` are the measured cases — the one exit is `@boundary` on the whole
  function, which says more than the change that triggered the report.

### Functions with no record

A function Ambit could not extract — the `skipped` count in `--coverage`, and the
symbols `AMB-E003` names as having nowhere to hang a contract — has no record on
either side, so no comparison is made for it.

### A sharper analysis cancels out

Both sides are analyzed by the *running* Ambit — one process, two trees — so
anything that changes only in the analyzer cancels out. Measured on 2026-09-11,
when naming factory-created clients moved nine functions in
`test/fixtures/realistic-api` from `unknown` to real `db_read` / `db_write`:
`diff HEAD test/fixtures/realistic-api` reported those nine as unchanged, and
reported only the two increases that came from a contract actually edited in the
tree ([2026-09-11](measurements/2026-09-11-coverage-and-latency.md)). The same
property is what keeps `diff HEAD~1 src` green in CI across an analyzer change.

### `node_modules` in the base checkout

The working tree's `node_modules` is symlinked into the base checkout before the
base side is analyzed. Without it the two sides differ by their environment
rather than by their contracts. Re-measured on 2026-09-10 against commit
`42addc9`:

| Reason | Without `node_modules` | With it |
|---|---:|---:|
| unresolved call sites, total | 498 | 479 |
| `any-typed` | 77 | — |
| `external-module` | 64 | 331 |
| `unresolved-symbol` | 236 | 17 |

Every directory from the repository root down to the checked one is linked, not
the root alone, because a package inside a workspace keeps its dependencies
beside itself
([2026-09-11](measurements/2026-09-11-second-third-party-validation-immich.md)).
A `node_modules` *below* the checked directory is not linked; that invocation has
other unsettled parts (config discovery, multiple tsconfigs) and is in
[`docs/open-questions.md`](open-questions.md) under Monorepos.

### Approval lines outside the `Approvals` region

A line written *above* the `Approvals` heading is prose and is not reported at
all. That is what lets `ambit.approvals.md` explain itself in a bullet list, and
it also means an approval written in the wrong place is silently inert; the
increase still fails, so the failure is visible, and the reason for it is one
line further away.

## Runtime hooks and adapters

The adopter-facing limits are in [`docs/limitations.md`](limitations.md); these
are the reasons behind the ones stated there without one.

- **Paths** are resolved to absolute at the call with `path.resolve`,
  `fileURLToPath`, and `Buffer` decoding.
- **A shell spawn names the shell** because which program a command string runs
  is not decidable without a shell parser. The exception message says that a
  grant for the shell permits any program the shell can start.
- **Both adapters are a devDependency here and a type-only import**, so the
  published package depends on neither `hono` nor `next`.
- **A missing registration is never read as an empty grant**: an empty grant
  would make a forgotten route look like a policy decision.
- **Next.js paths without an adapter.** Server Actions (`"use server"`) are not
  route modules and have no registration call a `spec` could ride on;
  `middleware.ts` runs on the Edge runtime and outside every route module; the
  Pages Router has a different handler shape.
- **The Edge runtime.** `installFsHook` and `installChildProcessHook` wrap
  `node:fs` and `node:child_process`, which do not exist there. Leaving an Edge
  route unwrapped is the honest form: a registration that reads as enforced and
  is not would be worse than none.

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

No `bodyless-declaration` appears because `src/` contains no overload signature,
`abstract` member, or `.ts`-file `declare`.

| Field | Meaning |
|---|---|
| `unknown-rate` | the share of extracted functions whose effects could not be fully determined |
| `mutation` | in-place mutation sites, counted apart from `pure`: a local one carries no effect but is not the same evidence as a call proven pure, and an escaping one is a `state_write` no stub table produced |
| `skipped` | function-like nodes that cannot carry a contract, by kind (see above) |
| `unresolved-by-reason`, `top-unresolved-names` | the signal for what to stub next. `Array.push` and `Map.set` do not appear in it: the mutating-method table answers them, and they are counted under `mutation` |

`top-unresolved-names` lists only calls a textual name could be built for, and
only the ten most frequent. An unresolved call with no name raises the
`unresolved-symbol` count and appears nowhere else, so this list is not a
complete picture of what is unresolved.

This number is not a target that has been met, and it is dominated by
`external-module` — almost entirely calls into the TypeScript compiler API from
the one file meant to be replaceable. It says nothing about an *adopting team's*
code, whose rate is set largely by its own dependencies: `ROADMAP.md` tracks that
relative to the team's first run, and `docs/status.md` records the
adopting-team-equivalent fixture, `test/fixtures/realistic-api`, separately. The
figures must not be mixed.

The summary line (`files= functions= declared=`) is printed on every run, with or
without `--coverage`, so a check that analyzed nothing is never indistinguishable
from a check that found no violations.
