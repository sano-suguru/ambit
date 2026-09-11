# Known limitations

Implementation status of `ambit check` — what the analysis actually sees
today, and where it stops. This file records current behavior, not design
intent; the specification is [DESIGN.md](DESIGN.md), and design-level open
questions live in [`docs/open-questions.md`](open-questions.md).

Ambit is experimental. Expect this file to shrink as the analysis grows.

The corner cases below the level an adopter needs — which call shapes resolve,
which stub keys match, what `--coverage` counts — are in
[`docs/analysis-limitations.md`](analysis-limitations.md).

## Security boundary

**Ambit is not a sandbox.** It does not isolate code, and it offers no defence
against code written to evade it. Three things follow, and none of them is a
gap to be closed later:

- **Static analysis is not sound.** `unknown` marks what the analysis did not
  reach, and a `@boundary` marks what it was told not to look at. Neither is a
  claim that nothing happens there.
- **Runtime enforcement covers the four hooks below and nothing else.** An
  operation with no hook is neither blocked nor recorded. A hook is a replaced
  function: code that holds a reference taken before installation, or that
  reaches an API through an internal path, is not intercepted.
- **An approval is a record, not a verification.** `ambit diff` cannot tell
  whether a human wrote an approval line; an agent can write one as easily as
  a reviewer can (see below).

What Ambit does claim is narrower and checkable: that an authority increase
shows up in the diff, and that what it could not analyze stays visible rather
than being reported as safe (DESIGN.md §3.4, P4).

## Contract tags

`@effects`, `@capabilities`, `@budget`, `@entrypoint`, and `@boundary` are all
parsed. `@effects` and `@capabilities` are checked statically; `@budget` is
validated but only `timeMs` is enforced, at runtime, through `withAmbit` or an
adapter's `ambitHandler` / `ambitRoute`.

The `@capabilities` check has two halves (DESIGN.md §4.4's dual enforcement):

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

A `withAmbit(spec, handler)`, or an adapter's `ambitHandler(spec, handler,
decode)` / `ambitRoute(spec, handler, decode)`, whose `capabilities` is a
literal array and whose `handler` names a
declaration in the same file *is* that handler's `@capabilities` (DESIGN.md
§4.4). `spec.budget` is the handler's `@budget` under the same conditions,
independently of the capability half. Writing the tag as well is still
allowed and still checked: the two disagreeing is `AMB-E010` / `AMB-E011`,
an error.

Two cases fall outside that, and in both the JSDoc tag is still required:

- **a spec Ambit cannot read** — a capability list built at runtime, a budget
  that is not an object literal of literal limits;
- **a handler from another module** — the registration names no declaration in
  the file, so there is no summary to attach the declaration to. This is
  [`docs/open-questions.md`](open-questions.md)'s "Mapping contracts to handlers" (2),
  still open.

Either is reported as `AMB-W004`, whose message says that the handler's own
JSDoc is the only declaration there. Neither is silently treated as unknown:
an entrypoint left with no capability set is `AMB-W002` as well. Ambit has no
measurement of how often either case occurs in general code — in
`test/fixtures/realistic-api` every registration names a same-file handler.

Runtime enforcement covers `globalThis.fetch`, `node:fs`/`node:fs/promises`,
`node:child_process`, `pg`, and `@budget timeMs`. `costUsd` and `llmCalls` are
parsed and carried on the context, and nothing increments them.

## Commands and flags

`ambit check`, `ambit init` and `ambit diff` are implemented, with `--format
json`, `--format github`, `--coverage`, `--strict`, and `init --config`.
`--format github` renders the same diagnostics as GitHub Actions workflow
commands, with the call path folded into the annotation body; on `check` it
changes no exit code. `ambit run`, `ambit agent`, `ambit stubs`, and `ambit
sbom` are planned, not built.

`ambit init` proposes `@effects` JSDoc. `ambit init --config` proposes an
`ambit.config.ts` entry instead, for the declarations no comment can carry —
and only by appending to an existing `contracts: {` block. It creates no
config file: the `defineConfig` import specifier depends on how the consumer
installed Ambit, and DESIGN.md §5.3 forbids emitting a patch that may not
apply.

### What `ambit diff` can and cannot see

`ambit diff <ref>` compares the working tree's authority against a base ref
and fails on an increase that no approval covers (DESIGN.md §6.3).

It exists because `check` alone cannot catch a widened declaration. `check`
validates the code against whatever contract is currently written, so editing
the tag along with the code — including by applying the `widen` fix Ambit itself
offers — makes it green again. Measured on `test/fixtures/accident`, changing
`priceOrder` from `@effects pure` to `@effects network` takes
`check test/fixtures/accident` from exit 1 to exit 0, while
`diff HEAD test/fixtures/accident` exits 1 and names the hop that carried the
authority:

```text
Authority increased in 1 symbol:

  pricing.ts#priceOrder (pricing.ts:4)
    + network
      -> applyTax (tax.ts:3)
      -> currentRate (rates.ts:3)
      operation: fetch (rates.ts:4)
```

Five things `diff` does not see, or sees differently from how a reader might
expect:

- **A function whose file git does not report as renamed reads as a deletion
  plus a new symbol.** A symbol id is `<path relative to the checked
  directory>#<declaration path>` (DESIGN.md §5.3), so
  `src/tax.ts#calculateTax` and `src/pricing/tax.ts#calculateTax` are two
  different symbols. `ambit diff` re-expresses the base side's ids under the
  head side's paths for every rename `git diff --find-renames` reports, so an
  ordinary file move is compared against itself and needs no approval. Two
  cases are left, and each costs one approval line: a function renamed
  *within* a file (git reports no rename, and matching two declaration paths
  inside one file would be a guess about identity), and a move git does not
  detect — because the edit that came with it fell under its similarity
  threshold, or because the new path is not tracked yet, since rename
  detection compares the index and the working tree against the base commit.
  Both over-report rather than under-report, which is the direction §3.4
  requires.
- **Gaining `unknown` is not an increase, because unknown is not authority.**
  A call the analysis cannot resolve means the effect set may be incomplete
  (DESIGN.md §4.3) — it does not mean the function acquired anything. `ambit
  diff` reports the symbols that newly reach an unresolved call in their own
  section and exits 0 on them alone. A range that stopped being analyzable is
  never reported as "nothing increased here", but it does not fail a build
  either. If that matters for a directory, `check --strict` is the tool that
  makes an unresolved call an error.
- **A symbol with no declaration path never appears at all.** A function
  Ambit could not extract — the `skipped` count in `--coverage`, and the
  symbols `AMB-E003` names as having nowhere to hang a contract — has no
  record on either side, so no comparison is made for it. Whatever authority
  such a function gains, `ambit diff` is silent about it. The `skipped`
  breakdown in `check --coverage` is the number to read alongside a green
  diff.
- **A sharper analysis is not an increase.** Both sides are analyzed by the
  *running* Ambit — one process, two trees — so anything that changes only in
  the analyzer cancels out. Measured on 2026-09-11, when naming
  factory-created clients moved nine functions in
  `test/fixtures/realistic-api` from `unknown` to real `db_read` / `db_write`:
  `diff HEAD test/fixtures/realistic-api` reported those nine as unchanged,
  and reported only the two increases that came from a contract actually
  edited in the tree. The same property is what keeps `diff HEAD~1 src` green
  in CI across an analyzer change. The flip side is worth saying: `diff` is
  silent about authority that a *previously installed* Ambit would have
  missed. Upgrading Ambit surfaces that in `check`, not here.
- **It compares two trees, so it runs the analysis twice.** There is no cache
  and no resident path (DESIGN.md §6.2 is a separate open question), and the
  base side is a fresh `git worktree`. Measured on this repository, five runs
  each: `check src` 1.07–1.11 s, `diff HEAD src` 1.86–1.98 s.

### What an approval means, and what it does not

An increase passes when `ambit.approvals.md` gains a line naming it, in the
same change (DESIGN.md §6.3). Three limits of that are worth stating plainly:

- **Ambit does not know a person wrote the line.** An agent can write one as
  easily as a reviewer can. What the mechanism supplies is the record and its
  visibility in the pull request's diff; what supplies the person is the
  repository's branch protection, and a `CODEOWNERS` entry naming the file so
  that changing it needs an approver. Neither is something Ambit can check.
- **An approval says nothing about whether the increase is safe.** It says one
  named increase was shown to whoever read the diff.
- **A malformed line grants nothing and does not fail on its own.** A `- ` line
  under the `Approvals` heading that does not parse is reported with its line
  number; the increase it was meant to approve stays unapproved, and that is
  what fails. A line written *above* that heading is prose and is not reported
  at all — which is what lets the file explain itself in a bullet list, and
  also means an approval written in the wrong place is silently inert. The
  increase still fails, so the failure is visible; the reason for it is one
  line further away.

The working tree's `node_modules` is symlinked into the base checkout before
the base side is analyzed. Without it the two sides differ by their
environment rather than by their contracts: re-measured on 2026-09-10 against
commit `42addc9`, a checkout without `node_modules` reports 498 unresolved call
sites against 479 with it, and an `any-typed` reason (77 sites) that the side
with `node_modules` does not have at all — `external-module` 64 against 331,
`unresolved-symbol` 236 against 17.

## `ambit.config.ts`

Out-of-code contracts (DESIGN.md §4.1) are implemented for all five tags. Two
things the specification mentions are not:

- **No `stubs` key.** A package's effect definitions still come only from the
  bundled tables in `src/stubs/`; neither config nor a package-provided
  `ambit.stubs.json` (§4.2) is read.
- **No price table**, so `@budget costUsd` is still never enforced (§4.5).

Which declaration sites a config key can and cannot name — and the three kinds
that *only* a key can declare, because they have a declaration path but nowhere
to write a comment — is
[`docs/analysis-limitations.md`](analysis-limitations.md).

## Effect inference

Effects are inferred from four bundled tables in `src/stubs/`: Node.js builtins
and `fetch` (52 entries), database and LLM clients (49 rules over `pg`,
`mysql2`, `knex`, `@prisma/client`, `openai`, `@anthropic-ai/sdk`), pure
built-ins (36 methods), and in-place mutators (19 methods). Everything else is
`unknown`.

Three consequences an adopter should count on:

- **Only those six client packages are covered.** Drizzle, MongoDB, Redis, an
  S3 client, a queue client, an HTTP client that is not `fetch` or `undici`
  (`ky`, `axios`, `got`) — all `unknown`.
- **A client must be one a package's own types describe.** Four shapes reach
  the table: a `const` initialized by `new <ImportedClass>(…)` or by an
  imported factory (`createPool(…)`), and — through the receiver's declared
  type — a client held in a class field, handed in as a parameter, or returned
  by an earlier call in a chain (`db(table).where(…).del()`). What stays
  `unknown` is a receiver no *package* type describes: one whose type this
  project declares, one the compiler's own lib declares, and an anonymous
  object type.
- **An opaque SQL statement costs both directions.** A `query` whose leading
  keyword the source does not fix contributes **both** `db_read` and
  `db_write`, so a read-only function that builds its statement dynamically
  has to declare `db_write` (DESIGN.md §4.2).

**Which call shapes resolve and which do not** — the stub-key matching rules,
call resolution through aliases and re-exports, higher-order functions,
`new X(...)`, which function-like nodes can carry a contract, and how
`--coverage` counts — is [`docs/analysis-limitations.md`](analysis-limitations.md).

## Scale

**There is no incremental or resident analysis** (DESIGN.md §6.2). Every run is
a full analysis: a re-check after a one-line edit costs what the first check
cost. Measured on this repository, five runs each: `check src` 1.07–1.11 s,
`diff HEAD src` 1.86–1.98 s — `diff` analyzes two trees. Nothing here has been
measured at the scale of a large application.

## Runtime hooks

Four hooks enforce `@capabilities` at run time: `installFetchHook()`,
`installFsHook()`, `installChildProcessHook()` and `installPgHook(pg)`. Each
returns the function that restores what it replaced. Everything below is what
they do **not** cover.

### What is hooked, and at which version

| Hook | Target | Versions |
|---|---|---|
| `installFetchHook` | `globalThis.fetch` | the Node.js runtime Ambit supports (`engines.node`) |
| `installFsHook` | `node:fs`, `node:fs/promises` | same |
| `installChildProcessHook` | `node:child_process` | same |
| `installPgHook` | `pg`'s `Pool.prototype.query`, `Client.prototype.query` | `pg` 8.x — verified against `pg@8` in `test/e2e.runtime.test.ts` |

Not hooked at all, and therefore neither blocked nor recorded: `mysql2`,
`@prisma/client`, `drizzle-orm`, `mongodb`, `openai`, `@anthropic-ai/sdk`,
the Vercel AI SDK, `node:http`/`https`/`net` (their effects are inferred
statically, but no runtime hook replaces them), and every other client. Ambit
has no way to notice that an upstream release moved a patch point; the `pg`
row above is a claim about the version tested, not about future ones
([`docs/open-questions.md`](open-questions.md)).

### Install order decides what a builtin hook covers

A builtin's ESM namespace is a snapshot of its properties taken when that
builtin is first `import`ed anywhere in the process.

- Installed from a preload (`node --import ./ambit-hooks.mjs app.js`), before
  the application's module graph is linked, the hooks cover every form:
  `import { readFileSync } from "node:fs"`, `import fs from "node:fs"`, and
  `require("fs")`.
- Installed from inside the module graph — a call at the top of the entry
  module — they cover `fs.readFileSync()` through the default export and
  through `require("fs")`, but **not** a named import
  (`import { readFileSync } from "node:fs"`) or `import * as fs`, which are
  already bound to the original function.

Neither mode covers a native addon, code inside a child process, or another
`worker_threads` worker: a worker needs its own install.

### Node's own module loader reads through the hook

Node reads module sources with the public `fs.readFileSync`. After
`installFsHook()`, a `require()` or a dynamic `import()` therefore goes
through the capability check like any other read. Under
`setUnscopedPolicy("deny")`, or inside a `withAmbit` context that grants no
`fs:read`, a lazily loaded module is denied. Load what you need before
installing the hook, or grant `fs:read:` for the directories that hold the
code.

### What a target can and cannot say

- **Paths** are resolved to absolute at the call (`path.resolve`,
  `fileURLToPath`, `Buffer` decoded), so a grant is written as an absolute
  path glob. `*` crosses `/`: `fs:read:/srv/app/*` also covers
  `/srv/app/a/b.txt`. There is no way to grant exactly one directory level.
- **File descriptors** carry no path. `fs.readSync(fd)` is not checked; the
  check happened at `open`, from the flags. A descriptor obtained before the
  hook was installed is never checked.
- **A shell spawn names the shell.** `exec`, `execSync` and `shell: true`
  give `proc:spawn:/bin/sh` (or `options.shell`). Which program the command
  string runs is not decidable without a shell parser, so a grant for the
  shell permits any program the shell can start — the exception message says
  this.
- **A `pg` target is the database, never a table.** Ambit does not read table
  names out of SQL, so `db:read:users` — which reads like a table grant — is
  not what the `pg` hook matches; it matches `db:read:<database>`.
  Table-level `db:` targets have meaning only in the static narrowing rule
  (`AMB-E005`). When the connection names no database, the requirement
  becomes `db:read:unknown`, which only a target-agnostic grant
  (`db:read:*`) covers.
- **An opaque statement requires both directions.** A `query` whose leading
  SQL keyword is not readable — a `Submittable`, a config object without
  `text` — requires `db:read:` *and* `db:write:`.

### `costUsd` and `llmCalls` are still not enforced

No hook increments them, and none of the four hooks changes that. They are
parsed, validated, and carried on the context for an adapter to use.

## Framework adapters

Two adapters exist: `ambitHandler` from `ambit-ts/runtime/hono` and `ambitRoute`
from `ambit-ts/runtime/next`. Express, BullMQ, `worker_threads` and the rest have
none, and a handler they register establishes no Ambit context.

Both are declared the same way: a devDependency here and a type-only import,
so the published package depends on neither `hono` nor `next`. Both enforce the
same thing — the capability set and `@budget` of the route they register, for
the handler and its `decode`.

| Adapter | Verified against | By |
|---|---|---|
| `ambit-ts/runtime/hono` — `ambitHandler` | `hono@4`, `@hono/node-server@1` | `test/runtime.hono.test.ts` in process, `test/e2e.runtime.test.ts` through a real server and a real socket, `test/e2e.install.test.ts` through the installed package |
| `ambit-ts/runtime/next` — `ambitRoute` | `next@16`, Node.js runtime only | `test/runtime.next.test.ts` — the exported Route Handler called directly with a real `NextRequest`, which is what Next.js does with it; `test/e2e.next-app.test.ts` for an `app/**/route.ts` project through `ambit check`; `test/e2e.install.test.ts` type-checks README's route and `instrumentation.ts` snippets against the installed package |

What the Next.js row does **not** claim: no test starts a `next` server
process, so the adapter is verified as a Route Handler function, not as a
running Next.js application. Nothing is verified on the Edge runtime.

Limits of what the adapters guarantee:

- **Only the route it registers.** `app.get(path, handler)` written without
  `ambitHandler` establishes no context, so operations inside it are decided by
  `setUnscopedPolicy` (`allow` by default) — not by the handler's JSDoc, which
  the runtime never reads. The adapter does not scan the app for unwrapped
  routes, and nothing reports one.
- **Middleware ordering.** The context exists only inside the wrapped handler.
  Middleware registered with `app.use` runs *outside* it — before and after —
  so anything a middleware does is unscoped even when the route it fronts is
  wrapped. Middleware that runs `next()` and then touches a hooked API is
  therefore not covered by that route's capabilities.
- **A contract that is not found is not a denial.** There is no lookup that can
  fail: the contract is the `spec` argument. A missing contract means a missing
  registration, which the adapter treats as "no context", never as "no
  capabilities" — an empty grant would make a forgotten route look like a
  policy decision.
- **Errors are not HTTP statuses.** `AmbitCapabilityError` and
  `AmbitBudgetError` reach the framework's error handler (Hono's default: a
  bare 500). Nothing maps them to 403 or 504, and the message — which names the
  granted set — is not put in a response body by Ambit.
- **The wrapped route returns a plain `Response`**, so Hono's RPC type
  inference (`hc`) sees `Response` rather than the handler's return shape.
- **`timeMs` includes `decode`**, which runs inside the context: the time spent
  reading a request body counts against the budget.
- **Only `app/**/route.ts`, registered through `ambitRoute`.** Next.js runs
  code down several paths, and the adapter reaches one of them. Server Actions
  (`"use server"`) are not route modules and have no registration call a `spec`
  could ride on; `middleware.ts` runs on the Edge runtime and outside every
  route module; the Pages Router (`pages/api/*`) has a different handler shape.
  None of the three has an adapter, none establishes an Ambit context, and
  `setUnscopedPolicy` decides what operations inside them do — `allow` by
  default. Nothing reports a handler on those paths as unregistered, the same
  way nothing reports an unwrapped Hono route.
- **The Edge runtime is not enforced.** A Next.js route that sets
  `export const runtime = "edge"` leaves the Node.js runtime, and every hook
  Ambit installs is a Node.js hook: `installFsHook` and
  `installChildProcessHook` wrap `node:fs` and `node:child_process`, which do
  not exist there, and the `register()` README documents installs nothing
  unless `process.env.NEXT_RUNTIME === "nodejs"`. **No capability is checked on
  an Edge route.** Nothing further about `ambitRoute` there is claimed either —
  no test runs on the Edge runtime, so whether the context is established at
  all is unverified. [`docs/open-questions.md`](open-questions.md)'s "Edge runtimes" guarantees the Node.js
  runtime only in Phase 1. Leaving an Edge route unwrapped is the honest form:
  a registration that reads as enforced and is not would be worse than none.
- **A file that imports `ambit-ts/runtime/<framework>` does not type-check after
  `npm remove ambit-ts`.** P5 (DESIGN.md §2, "allow backing out at any time")
  guarantees that the JSDoc contracts survive removal — they are comments on
  ordinary TypeScript, and nothing reads them at run time. The adapter call is not
  covered by that: `ambitHandler(spec, handler, decode)` is a value imported
  from Ambit, so removing the package leaves an unresolved import and a route
  registration with no replacement. Backing out of an adapted route means
  editing the source — replacing each `ambitHandler(...)` with the framework's
  own handler — not only deleting a dependency.

## Backend

The analysis backend (`src/checker/backend/legacy-ts.ts`) is a connection layer
over the TypeScript compiler API. It is the adopted default (DESIGN.md §3.5,
ADR-0001), and it stays replaceable: the conditions that would reopen the choice
are written down in §3.5, and no performance number is claimed for a backend
that has not been run.

Where the analysis is narrower than the specification, at the level of
individual syntax, is [`docs/analysis-limitations.md`](analysis-limitations.md).

