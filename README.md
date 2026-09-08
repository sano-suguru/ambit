# Ambit

**Make AI-written TypeScript obey explicit boundaries.**

AI agents can change code faster than humans can review the expansion of
authority those changes introduce. The name comes from *ambit*: the range of
one's authority or activity. Ambit makes that range explicit and mechanically
checks it — declared boundaries, not silent trust.

- Can this function reach the network?
- Can it read or write this database?
- How much time or money is an entrypoint allowed to spend?
- What happens when an agent quietly expands what a function can do?

Only the first is enforced today — see [Status](#status).

## The accident

```ts
/** @effects pure */
export function calculateTax(order: Order): Money {
  // ...
}
```

An agent later adds a `fetch()` call inside it. Then:

```console
$ node src/cli/main.ts check src
error: calculateTax declares pure but performs [network] directly (tax.ts:2)
```

With `--format json`, the same violation comes out as NDJSON, meant to be
consumed by an agent directly:

```json
{"id":"AMB-E001","severity":"error","category":"effects","message":"calculateTax declares pure but performs [network] directly","location":{"file":"tax.ts","line":2,"col":17,"endLine":2,"endCol":29},"contract":{"declared":["pure"],"observed":["network"],"via":[]},"fixes":[],"docs":"docs/diagnostics/README.md#amb-e001","engine":{"name":"typescript-legacy","version":"5.9.3"}}
```

## Status

**Ambit is experimental and not production-ready.**

Today `ambit check` enforces `@effects`. `@capabilities`, `@budget`, and
`@entrypoint` are part of the contract model and documented in the design
spec, but are not implemented yet. `ambit init`, `ambit run`, `ambit agent`,
`ambit stubs`, and `ambit sbom` are planned, not built. `ambit check` always
reports how many files and functions it analyzed, so a check that saw
nothing is never silently indistinguishable from a check that found no
violations; `--coverage` additionally reports the function-level `unknown`
rate, why individual calls could not be resolved, and the most frequent
unresolved call names — the signal for what to stub next. `ambit check`'s
`--strict` flag is not built yet, and passing it is rejected (exit 2) rather
than silently ignored. Runtime enforcement has not been started — everything
Ambit checks today is static. `ambit` is not published yet; run it from a
clone as `node src/cli/main.ts check <dir>`.

Effects are inferred from two bundled tables. The first, 23 entries (`fetch`
plus Node.js builtins), produces only `network`, `fs_read`, `fs_write`, and
`process`. No bundled stub produces `db_read`, `db_write`, `llm`, or `env` —
those enter the analysis only when something declares them explicitly. A
`pure` function calling a database driver reports `unknown`, not a
violation. Stub matching is also import-shape sensitive:
`import * as fs from "node:fs"` is recognized, `import { writeFileSync }
from "node:fs"` is not, and falls back to `unknown`.

A separate, smaller table (`src/stubs/pure-builtins.ts`) allowlists default-lib
methods reached through a local value (`set.has(...)`, `arr.map(...)`) that
have no import binding for the stub table above to key on — `checker.
getFullyQualifiedName()` names them instead (`"Set.has"`, `"Array.map"`), in
a namespace kept separate from the module-specifier one. It is deliberately
narrow: it excludes anything that mutates (`Array.push`, `Array.sort`,
`Map.set`, `Set.add`), and a method that can take a callback (`map`,
`filter`, `reduce`, ...) is trusted only when that callback is written inline
— `arr.map(x => ...)` is walked and attributed to the enclosing function,
but `arr.map(namedFn)` passes a callback Ambit never sees, so it stays
`unknown` even though `Array.map` itself is allowlisted.

Higher-order functions (a callback's effects inferred from the argument
passed at the call site) are not implemented; a call through a callback
parameter falls back to `unknown` rather than being inferred. Function
extraction — the set of function-like nodes that can carry their own
`@effects` contract — covers named function declarations, class methods, and
variable-bound function/arrow expressions. A call inside any other
function-like node (a getter/setter, an object-literal method, an anonymous
`export default` function, a nested function declaration, an inline callback
argument, or anything else with no extracted ancestor — e.g. a class
constructor) is still walked and its effects attributed to the nearest
enclosing *extracted* function, if there is one; it is only invisible when no
such ancestor exists. `ambit check --coverage` reports these nodes as
"skipped" by kind (`getter-setter`, `object-literal-method`,
`anonymous-default-export`, `callback-argument`, `nested-function`, and a
residual `other`) — not because their effects go unseen, but because none of
them can declare a contract of their own.

`new X(...)` is not recorded as a call at all, and not even as `unknown` —
`new PrismaClient()` or `new WebSocket(...)` disappears from analysis
entirely (`new Function(...)` is the sole exception, reported as an
`eval`-like unresolved call). A `pure` function that constructs a database
client or socket passes today.

The design is documented in [docs/DESIGN.md](docs/DESIGN.md) (a Draft — the
RFC process for spec changes starts at the first public release, so this
file is edited directly for now) and [docs/diagnostics/](docs/diagnostics/README.md)
(a diagnostic code ledger; ids like `AMB-E001` can still change before that
release).

## The problem

TypeScript tells you whether a value has the type you expect. It does not
tell you whether a function is allowed to do what it does. For code humans
write, that gap is closed by architecture, code review, conventions, and
institutional knowledge. That doesn't scale when an agent can rewrite large
parts of a codebase in a single session. Ambit turns part of that implicit
knowledge into a machine-checkable contract.

## What Ambit adds

Ambit adds JSDoc declarations to ordinary TypeScript. No new syntax, no
grammar change, and an unrecognized tag has no effect on runtime behavior.

### Effects

What side effects can this function perform?

```ts
/**
 * @effects network, db_read
 */
export async function getUser(id: UserId) { /* ... */ }
```

This is the part `ambit check` enforces today: it stops a call to `fetch` or
`node:fs` inside a function declared `pure`, and propagates effects through
the call graph.

### Capabilities *(designed, not yet implemented)*

Which specific resource may it access?

```ts
/**
 * @capabilities db:read:users
 */
export async function getUser(id: UserId) { /* ... */ }
```

### Budgets *(designed, not yet implemented)*

How much execution time or cost may an entrypoint consume?

```ts
/**
 * @entrypoint
 * @capabilities db:read:users, http:get:api.example.com
 * @budget timeMs=500 costUsd=0.01
 */
export async function GET(req: Request): Promise<Response> { /* ... */ }
```

## Designed for coding agents

**Available today:** machine-readable NDJSON diagnostics
(`ambit check --format json`).

**Planned:** stable diagnostic ids (from the first public release), suggested
fixes (`fixes[].edits` — patches that are actually applicable), impact
analysis, incremental re-checking, and inferring candidate contracts for
existing code.

The goal isn't to ask a model to remember architectural rules. It's to make
violations of those rules mechanically detectable.

## Unknown stays unknown

Ambit doesn't pretend static analysis can resolve everything. Dynamic
dispatch, callbacks, and unsupported APIs can prevent Ambit from proving what
a call does. In those cases Ambit reports `unknown` rather than silently
treating the call as safe — the boundary of the analysis stays visible
instead of hidden.

## Why not a new language

- A model writes more accurately in a language it has seen more of in
  training. Ambit doesn't assume the model will learn a new one.
- It builds on existing assets: npm, tsc, CI, editors.
- Contract declarations sit inside ordinary TypeScript, so removing Ambit
  later is a small diff, not a rewrite.

## Why TypeScript

Static contract checking benefits from the type, symbol, and call-signature
information a TypeScript compiler already produces. The initial target is
Node.js backend TypeScript — SaaS APIs, background workflows, LLM agents,
data processing — the kind of code coding agents write in bulk today. The
baseline runtime is Node.js 24 LTS.

## What Ambit does not do

- Change the grammar, build a custom transpiler, build a custom runtime, or
  build a custom package registry
- Support other languages such as Python
- Target browsers, frontend code, operating systems, or embedded systems
- Design around the assumption that "the next model won't make this mistake"
- Guarantee performance without measurement, or guarantee runtime
  enforcement for unsupported APIs or execution environments

## Implementation

Ambit's own analysis backend is not settled. Implementation choices —
including which TypeScript compiler API it depends on — are treated as
replaceable until measurement and compatibility testing justify them. See
[docs/DESIGN.md](docs/DESIGN.md).

## The thesis

AI has sharply cut the cost of producing code. It hasn't cut the cost of
deciding whether that code should be allowed to do what it does. Ambit is an
experiment in moving that boundary from human convention into an executable
contract.
