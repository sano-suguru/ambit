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
files=1 functions=1 declared=1
```

With `--format json`, the same violation comes out as NDJSON, meant to be
consumed by an agent directly:

```json
{"id":"AMB-E001","severity":"error","category":"effects","message":"calculateTax declares pure but performs [network] directly","location":{"file":"tax.ts","line":2,"col":17,"endLine":2,"endCol":29},"contract":{"declared":["pure"],"observed":["network"],"via":[]},"fixes":[],"docs":"docs/diagnostics/README.md#amb-e001","engine":{"name":"typescript-legacy","version":"5.9.3"}}
```

## Quick start

`ambit` is not published to npm yet; run it from a clone. Requires Node.js 24
and pnpm.

```sh
git clone https://github.com/sano-suguru/ambit.git
cd ambit
pnpm install
node src/cli/main.ts check <dir>
```

There is no build step — `.ts` files run directly under Node's type stripping.

```sh
node src/cli/main.ts check src --format json   # NDJSON, one diagnostic per line
node src/cli/main.ts check src --coverage      # unknown rate and why calls stayed unresolved
```

`check` exits 0 when no error was reported, 1 when one was, and 2 when the
analysis itself could not run.

## Status

**Ambit is experimental and not production-ready.**

- **Works today:** `ambit check` statically verifies `@effects`. It detects
  undeclared use of `fetch` and the covered Node.js APIs, and propagates
  effects through the call graph. Diagnostics are available as text or NDJSON,
  and every run reports how many files and functions it analyzed, so a check
  that saw nothing is never indistinguishable from a check that found nothing.
- **Not yet:** `@capabilities`, `@budget`, and `@entrypoint` are specified in
  the design doc as part of the contract model, but nothing parses or checks
  them.
  Runtime enforcement has not been started — everything Ambit checks today is
  static. `ambit init`, `ambit run`, `ambit agent`, `ambit stubs`, and
  `ambit sbom` are planned, not built. `check --strict` is rejected (exit 2)
  rather than silently ignored.
- **Safety posture:** a call Ambit cannot resolve is reported as `unknown`,
  not assumed safe. The bundled effect tables are deliberately small, so a lot
  of real code lands in `unknown` today — see
  [Known limitations](#known-limitations).

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
parts of a codebase in a single session. AI has sharply cut the cost of
producing code; it hasn't cut the cost of deciding whether that code should
be allowed to do what it does. Ambit is an experiment in moving that boundary
from human convention into an executable contract.

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

`ambit check --format json` emits machine-readable NDJSON: one diagnostic per
line, each carrying the declared and observed contract, the propagation path,
and a docs link, followed by a summary line. It is meant to be piped straight
into an agent. The field shape and the diagnostic ids can still change before
the first public release.

The goal isn't to ask a model to remember architectural rules. It's to make
violations of those rules mechanically detectable.

## Unknown stays unknown

Ambit doesn't pretend static analysis can resolve everything. Dynamic
dispatch, callbacks, and unsupported APIs can prevent Ambit from proving what
a call does. In those cases Ambit reports `unknown` rather than silently
treating the call as safe — the boundary of the analysis stays visible
instead of hidden.

There is one gap in that promise today: `new X(...)` is not recorded as a call
at all, so it does not even surface as `unknown`. See below.

## Known limitations

Representative cases where analysis is narrower than the model suggests:

- **`new X(...)` is invisible.** Constructor calls are not recorded, not even
  as `unknown`, so a `pure` function that does `new PrismaClient()` or
  `new WebSocket(...)` passes today.
- **Small bundled effect tables.** 25 entries (`fetch` plus Node.js builtins)
  producing only `network`, `fs_read`, `fs_write`, and `process`. Nothing
  bundled produces `db_read`, `db_write`, `llm`, or `env` — a `pure` function
  calling a database driver reports `unknown`, not a violation.
- **Import-shape sensitive matching.** `import * as fs from "node:fs"`,
  `import fs from "node:fs"`, and `import { writeFileSync } from "node:fs"`
  are all recognized; a destructured or re-exported binding several hops
  away (e.g. through a barrel file) is not.
- **No higher-order inference.** A call through a callback parameter is
  `unknown`; a callback passed by name (`arr.map(namedFn)`) is never seen.
- **Not every function can carry a contract.** Getters/setters,
  object-literal methods, anonymous default exports, and nested functions
  cannot declare `@effects` of their own. Their calls are attributed to the
  nearest enclosing extracted function when there is one; with no such
  ancestor, the call is invisible.

Full detail, including how to read `--coverage` output, is in
[docs/limitations.md](docs/limitations.md).

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

## Roadmap

Direction, not commitments — nothing here is scheduled.

- `@capabilities` and `@budget` enforcement, and runtime enforcement
- Stable diagnostic ids (from the first public release)
- Suggested fixes (`fixes[].edits` — patches that are actually applicable)
- Impact analysis and incremental re-checking
- Inferring candidate contracts for existing code
