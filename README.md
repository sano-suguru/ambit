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

The first two are checked statically, for the packages Ambit ships stubs for.
The third is declared and validated, and only `timeMs` is enforced at runtime.
See [Status](#status).

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

Requires Node.js 24.

### Install into your project

`ambit` is not published to npm yet, so install it from a tarball you build
from a clone:

```sh
git clone https://github.com/sano-suguru/ambit.git
cd ambit && pnpm install && pnpm pack        # → ambit-0.0.0.tgz
cd /path/to/your-project
npm install -D /path/to/ambit/ambit-0.0.0.tgz
npx ambit check src
```

```sh
npx ambit init src                  # propose @effects for undeclared functions
npx ambit check src --format json   # NDJSON, one diagnostic per line
npx ambit check src --coverage      # unknown rate and why calls stayed unresolved
npx ambit check src --strict        # treat unresolved paths as errors, not warnings
```

Removing it is `npm remove ambit`. The `@effects` declarations left behind are
ordinary JSDoc comments: the project still type-checks and still runs. Both the
install path and the removal path are covered by an automated test against a
scratch project (`test/e2e.install.test.ts`).

### Run it from a clone

```sh
node src/cli/main.ts check <dir>
```

There is no build step during development — `.ts` files run directly under
Node's type stripping. A build exists only for distribution, because Node
refuses to strip types for files under `node_modules`.

`check` exits 0 when no error was reported, 1 when one was, and 2 when the
analysis itself could not run.

## Status

**Ambit is experimental and not production-ready.**

- **Works today:** `ambit check` statically verifies `@effects`. It detects
  undeclared use of `fetch` and the covered Node.js APIs, and propagates
  effects through the call graph. Diagnostics are available as text or NDJSON,
  and every run reports how many files and functions it analyzed, so a check
  that saw nothing is never indistinguishable from a check that found nothing.
- **Also works:** `@capabilities` is checked statically, in both halves of
  DESIGN.md §4.4's 二重強制. A callee may not require a capability its caller
  does not grant, and the check crosses undeclared functions; separately, a
  literal URL whose host falls outside the granted target is rejected at the
  call site (`AMB-E009`). A URL the source does not fix is reported as
  `AMB-W003` naming the runtime as the place it is matched, never as "allowed".
  A `withAmbit(...)` wrapping a handler declared in the same file is checked
  against that handler's `@capabilities` (`AMB-E010`). `@entrypoint` warns when
  it declares no capability set. `@boundary reason="…"` stops checking a body
  and trusts the declared contract instead, counted separately in
  `--coverage`. `@budget` is parsed and validated. `--strict` promotes the
  `unknown` warnings to errors.
- **`ambit init`:** proposes an `@effects` tag for every undeclared function
  whose effects resolved, as an applicable patch in the same NDJSON. It
  proposes nothing for a function that reached `unknown` — writing `pure`
  there would turn "could not tell" into a guarantee. It exits 0: contracts
  left to write are not a failed check.
- **Fix candidates:** an `AMB-E001` diagnostic carries one applicable patch
  (`fixes[].edits`, 0-based and end-exclusive) that widens the `@effects` tag
  to what was observed, marked `consistentWithContract: false` with the
  callers it would affect. There is no contract-preserving candidate: fixing
  the code instead of the contract means restructuring it, and Ambit does not
  invent a patch it cannot generate safely.
- **Runtime enforcement, for `fetch` only:** `ambit/runtime` establishes an
  entrypoint context and blocks an outgoing `fetch` whose
  `http:<method>:<host>` is not granted. See [What is actually
  enforced](#what-is-actually-enforced).
- **Not yet:** `@budget`'s loop-pattern
  warnings are not implemented. `ambit run`, `ambit agent`, `ambit stubs`, and
  `ambit sbom` are planned, not built. `ambit init` proposes JSDoc but does
  not write `ambit.config.ts` — out-of-code contracts (§4.1) are not
  implemented, so there is no config for it to write. There are no
  framework adapters — `withAmbit` is wrapped by hand.
- **Safety posture:** a call Ambit cannot resolve is reported as `unknown`,
  not assumed safe. The bundled effect tables are deliberately small, so a lot
  of real code lands in `unknown` today — see
  [Known limitations](#known-limitations).

A milestone-by-milestone account of what is implemented, what is verified, and
what is not built — with the measured coverage and latency numbers behind it —
is in [docs/status.md](docs/status.md).

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

This is the part `ambit check` enforces today: it stops a call to `fetch`,
`node:fs`, a `pg`/Prisma query, or an OpenAI/Anthropic request inside a
function declared `pure`, and propagates effects through the call graph.

### Capabilities *(statically checked; not enforced at runtime)*

Which specific resource may it access?

```ts
/**
 * @capabilities db:read:users
 */
export async function getUser(id: UserId) { /* ... */ }
```

Capabilities may only narrow from caller to callee. A function granting
`db:read:users` that reaches one requiring `db:write:users` is an error, even
through an undeclared function in between. Only the `target` segment may be a
glob: `db:read:*` covers `db:read:users`.

### Boundaries

Where the analysis stops, say so:

```ts
/**
 * @boundary reason="legacy SDK, not annotated"
 * @effects network
 */
export function callLegacySdk(payload: Payload) { return legacy.send(payload); }
```

The body is not checked; the declared contract is trusted in its place, and
`--coverage` counts boundaries apart from functions the analysis actually
resolved. `reason` is required, and so is a contract to trust — a `@boundary`
with no `@effects` only removes checking, and is reported.

### Budgets *(parsed and validated; not enforced at runtime)*

How much execution time or cost may an entrypoint consume?

```ts
/**
 * @entrypoint
 * @capabilities db:read:users, http:get:api.example.com
 * @budget timeMs=500 costUsd=0.01
 */
export async function GET(req: Request): Promise<Response> { /* ... */ }
```

## Runtime enforcement

Static checking cannot see a dynamic URL. For that, wrap the entrypoint:

```ts
import { withAmbit, installFetchHook } from "ambit/runtime";

installFetchHook();

export const GET = withAmbit(
  { capabilities: ["http:get:api.example.com"], budget: { timeMs: 500, onExceed: "throw" } },
  async (req: Request) => {
    await fetch("https://api.example.com/rates");   // allowed
    await fetch("https://elsewhere.example/steal"); // throws AmbitCapabilityError
  },
);
```

The blocked request never reaches the socket. With no active context, the
process-wide `setUnscopedPolicy("allow" | "warn" | "deny")` decides; the
default is `allow`, so adopting the runtime does not break code that has no
entrypoints declared yet. `installFetchHook()` returns a function that
restores the original `fetch`.

### What is actually enforced

| | Static check | Runtime block | Audit only | Unsupported |
|---|---|---|---|---|
| `@effects` | yes | — | — | — |
| `@capabilities`, caller→callee narrowing | yes | — | — | — |
| `@capabilities`, `globalThis.fetch` | — | yes | recorded on the context | — |
| `@capabilities`, literal URL in source | yes (`http:<method>:<host>`) | — | — | — |
| `@capabilities`, URL built at runtime | warns (`AMB-W003`) | yes, for `fetch` | recorded on the context | — |
| `@capabilities`, DB table / LLM target | — | — | — | not derived from source |
| `@effects` for `node:fs` / `child_process` / `pg` / `mysql2` / Prisma / OpenAI / Anthropic | yes | — | — | no runtime hook |
| `@budget timeMs` | — | yes (`throw` / `warn` / `abort`) | — | — |
| `@budget costUsd`, `llmCalls` | parsed and validated | — | — | no hook increments them |
| `@entrypoint` vs. the `withAmbit` beside it | yes, in the same file (`AMB-E010`) | — | — | no adapter links the two |

Two limits worth stating plainly. The `@entrypoint` / `withAmbit` agreement
check reads the **source**: it compares a literal capability array with the
JSDoc on a handler declared in the same file, and reports anything it cannot
compare as `AMB-W004`. Matching a contract to the handler that actually runs —
after a build strips the comments, or a bundler moves it — is DESIGN.md §12
「契約とハンドラの対応付け」 and is still open. And `costUsd`/`llmCalls` are
carried on the context but never incremented, because no LLM SDK is hooked;
they are not enforced limits.

The runtime currently ships in the same package as the CLI, so installing it
pulls in `typescript` as a production dependency. DESIGN.md §6 says it should
not — that split waits for the `@ambit/*` packages.

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

## Known limitations

Representative cases where analysis is narrower than the model suggests:

- **Small bundled effect tables.** 52 call entries (`fetch`, `undici`'s
  `fetch`, and Node.js builtins), 43 constructor entries, a 29-entry
  pure-builtin allowlist, a 19-entry in-place-mutation table, and 35
  database/LLM client rules (`pg`, `mysql2`, `@prisma/client`, `openai`,
  `@anthropic-ai/sdk`) — covering all nine effects. Everything outside those
  five packages and the Node.js builtins still reports `unknown`.
- **Client calls are matched through the value, not the type.** A method on a
  database or LLM client is recognized when the receiver is a `const` built
  from an imported class (`const pool = new Pool(...)` from `"pg"` gives
  `pg.Pool.query`), including through a barrel file. A client held in a class
  field, reassigned with `let`, or returned from a factory function is not
  matched, and reports `unknown`.
- **Reading a response body is `unknown`.** `(await fetch(url)).json()` is a
  method on a type from `@types/node` or `lib.dom`, and the pure-builtin
  allowlist covers only the compiler's own lib, so the call cannot be named.
  A function that parses a `fetch` response reports `unknown` and gets
  `AMB-W001`.
- **Import-shape sensitive matching.** `import * as fs from "node:fs"`,
  `import fs from "node:fs"`, `import { writeFileSync } from "node:fs"`, and a
  re-export chain through a barrel file are all recognized. A binding reached
  by destructuring a value (`const { readFile } = fs`) is not.
- **No higher-order inference.** A call through a callback parameter is
  `unknown`; a callback passed by name (`arr.map(namedFn)`) is never seen.
- **Construction is resolved, anonymous classes are not.** `new X(...)`,
  `super(...)`, a derived class's implicit base call, and a class's property
  initializers all propagate through `Class.constructor`. A construction of an
  anonymous class expression has no stable declaration path and stays
  `unknown`.
- **Only HTTP targets are read from source.** The static capability check
  covers `http:<method>:<host>` from a literal URL. No `db:` capability is
  derived from a SQL statement: DESIGN.md §4.4 is explicit that hooking a
  database client does not amount to deciding table-level permission for
  arbitrary SQL, and reading a table name out of a literal would be the same
  claim made somewhere else.
- **The `withAmbit` agreement check is source-only, same-file.** It compares a
  literal capability array with the JSDoc of a handler declared in the same
  file. A list built at runtime, a handler imported from elsewhere, or a
  handler with no contract is reported as `AMB-W004` — not compared, and not
  silently accepted.
- **Not every function can carry a contract.** Getters/setters, anonymous
  default exports, nested functions, and object-literal members the
  declaration-path notation cannot name (a computed or string key, a literal
  inside a function body) cannot declare `@effects` of their own. Their calls
  are attributed to the nearest enclosing extracted function when there is one;
  with no such ancestor, the call is invisible. Writing a contract on one of
  them is reported as `AMB-E003` rather than ignored.

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

- Runtime hooks beyond `fetch`: `node:fs`, `child_process`, DB and LLM clients
- Framework adapters (Express, Hono, Next.js) that link a declared
  `@entrypoint` to the running handler
- Deriving a capability target for operations other than HTTP — a table name,
  a bucket, a queue — which §4.4 currently leaves to the runtime
- Stable diagnostic ids (from the first public release)
- Impact analysis and incremental re-checking
