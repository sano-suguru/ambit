# Known limitations

What Ambit does not see, does not enforce, or costs to run — for someone deciding
whether to adopt it. This file records current behavior, not design intent; the
specification is [DESIGN.md](DESIGN.md), and design-level open questions are in
[`docs/open-questions.md`](open-questions.md).

Each limit below says what happens, and the workaround where one exists. Why the
analysis behaves that way, AST shape by AST shape, is
[`docs/analysis-limitations.md`](analysis-limitations.md). Ambit is
experimental; expect this file to shrink as the analysis grows.

## Security boundary

**Ambit is not a sandbox.** It does not isolate code, and it offers no defence
against code written to evade it. None of the following is a gap to be closed
later:

- **Static analysis is not sound.** `unknown` marks what the analysis did not
  reach, and `@boundary` marks what it was told not to look at. Neither is a
  claim that nothing happens there.
- **Runtime enforcement covers the four hooks below and nothing else.** An
  operation with no hook is neither blocked nor recorded. Code holding a
  reference taken before a hook was installed, or reaching an API through an
  internal path, is not intercepted.
- **An approval is a record, not a verification.** `ambit diff` cannot tell
  whether a human wrote an approval line.

What Ambit does claim is narrower and checkable: an authority increase shows up
in the diff, and what it could not analyze stays visible rather than being
reported as safe (DESIGN.md §3.4, P4).

## Contract tags

`@effects`, `@capabilities`, `@budget`, `@entrypoint` and `@boundary` are all
parsed; `@effects` and `@capabilities` are checked statically.

- **`@budget` enforces `timeMs` only**, at run time, through `withAmbit` or an
  adapter's `ambitHandler` / `ambitRoute`. `costUsd` and `llmCalls` are parsed,
  validated and carried on the context for an adapter to use; nothing increments
  them — none of the four hooks does — and there is no price table.
- **The static `@capabilities` check covers two things**: narrowing from caller
  to callee, and an HTTP target the source fixes as a literal (`AMB-E009`). A URL
  the source does not fix is reported as `AMB-W003`, naming the runtime as the
  place it is matched. No `db:` target is read out of a SQL statement.
- **A registration's `spec` declares the handler only when Ambit can read it.**
  On a `withAmbit`, `ambitHandler` or `ambitRoute` whose handler is declared in
  the same file, a literal `capabilities` array *is* that handler's
  `@capabilities`, and a literal `budget` its `@budget`, each independently of
  the other; a JSDoc tag that disagrees with it is `AMB-E010` / `AMB-E011`.
  A spec built at run time, or a handler imported from another module (an open
  question: [`docs/open-questions.md`](open-questions.md), "Mapping contracts
  to handlers"), is reported as `AMB-W004`, and an entrypoint left with no
  capability set as `AMB-W002`. How often that happens in general code is unmeasured.
  **Workaround:** write the tags in the handler's own JSDoc, which is then the
  only declaration.

## Commands and flags

`ambit check`, `ambit init` and `ambit diff` are implemented, with `--format
json`, `--format github`, `--coverage`, `--strict`, and `init --config`.
`--format github` renders the same diagnostics as GitHub Actions annotations,
with the call path folded into the annotation body; on `check` it changes no
exit code. `ambit run`, `ambit agent`, `ambit stubs` and `ambit sbom` are
planned, not built.

`ambit init` writes nothing: it proposes `@effects` JSDoc, and `init --config`
proposes `ambit.config.ts` entries only by appending to an existing `contracts:
{` block. It creates no config file.

### What `ambit diff` can and cannot see

`ambit diff <ref>` compares the working tree's authority against a base ref and
fails on an increase no approval covers (DESIGN.md §6.3). It exists because
`check` cannot catch a widened contract: editing the tag along with the code —
including applying Ambit's own `widen` fix — makes `check` green, and `diff`
still fails. [The accident](../README.md#the-accident-and-the-fix-that-is-not-one)
in README shows the output. How the comparison matches symbols is in
[`docs/analysis-limitations.md`](analysis-limitations.md#how-ambit-diff-compares).

What it can miss, or reports differently from how a reader might expect:

- **Inline route handlers are reported per file, not per handler.** Every
  handler written as a call argument
  (`router.post("/x", async (ctx) => { … })`) is compared under one entry,
  `routes.ts#<inline callbacks>`. An increase inside one is reported, but the
  call path may name a sibling that already held the authority, and the git
  diff is what says which handler changed.
  **Workaround:** bind the handler to a name
  (`const createDocument = async (ctx) => { … }`) to get one entry per route.
- **Authority moving between two inline handlers is not an increase.** One
  handler losing `network` while another gains it is reported only as "the
  bodies cannot be matched" — the same report a plain reorder produces — and no
  approval line is about it. `--strict` fails on it.
- **A function gaining an authority it already holds is silent.** A second
  `fetch` in a function that already reaches the network changes nothing, for a
  named function as much as for an inline handler.
- **A move git does not report as a rename costs an approval line.** A file
  rename git detects is compared against itself. A function renamed within a
  file, or a file moved with enough edits that git no longer calls it a rename
  (or not yet tracked), reads as a deletion plus a new symbol. This
  over-reports; it does not hide an increase.
- **Gaining `unknown` does not fail by default.** A symbol that stopped being
  resolved, or an `unknown` symbol whose body gained an operation the analysis
  cannot resolve, is reported in its own section at exit 0.
  **Mitigation:** `diff --strict` fails on it.
- **`--strict` is usable only where its reports can be closed.** For a package
  no bundled table covers (`axios` and `got` are the measured cases), the only
  exit is `@boundary` on the whole function: `ambit.config.ts` cannot declare a
  symbol inside `node_modules`. On all three measured third-party backends, whose
  tests are written as inline callbacks, adding one `expect(…)` line to a test
  file takes `--strict` from exit 0 to exit 1.
  **Workaround:** leave `--strict` off; the same report is printed at exit 0.
  The names at the top of `check --coverage`'s unresolved histogram are the stub
  requests worth filing.
- **A function Ambit cannot extract never appears.** It has no record on
  either side, so `diff` is silent about any authority it gains.
  **Mitigation:** read `check --coverage`'s `skipped` breakdown alongside a
  green diff.
- **Upgrading Ambit is not an increase.** Both sides are analyzed by the Ambit
  that is running, so authority an older Ambit missed does not show up in
  `diff`. It shows up in `check`.
- **A `node_modules` below the checked directory is not used for the base
  side.** The working tree's `node_modules` is linked into the base checkout
  from every directory between the repository root and the checked one. Running
  `diff` at a workspace root whose packages each install their own is not
  covered ([`docs/open-questions.md`](open-questions.md), Monorepos).
- **It runs the analysis twice.** There is no cache, and the base side is a
  fresh `git worktree`. The measured times are under Scale.

### What an approval means, and what it does not

An increase passes when `ambit.approvals.md` at the repository root gains a line
naming it, in the same change (DESIGN.md §6.3).

- **Ambit does not know a person wrote the line.** An agent can write one as
  easily as a reviewer can.
  **Mitigation:** branch protection, and a `CODEOWNERS` entry naming the file so
  that changing it needs an approver. Ambit can check neither.
- **An approval says nothing about whether the increase is safe.** It says one
  named increase was shown to whoever read the diff.
- **There is one ledger per repository.** A ledger in a subdirectory is not
  read, so approvers cannot differ by package: whoever may change the root file
  may approve an increase anywhere in the repository.
- **A misplaced or malformed approval grants nothing, and does not fail on its
  own.** A `- ` line under the `Approvals` heading that does not parse is
  reported with its line number. A line written
  *above* that heading is prose and is not reported at all. Either way the
  increase it was meant to approve still fails.

## `ambit.config.ts`

Out-of-code contracts are implemented for all five tags. Two things the
specification mentions are not:

- **No `stubs` key.** A package's effects come only from the tables bundled in
  `src/stubs/`; neither config nor a package-provided `ambit.stubs.json` is read.
- **No price table**, so `@budget costUsd` is never enforced.

Which declarations a config key can and cannot name is in
[`docs/analysis-limitations.md`](analysis-limitations.md#ambitconfigts).

## Effect inference

Effects come from four bundled tables in `src/stubs/`: Node.js builtins and HTTP
clients (59 entries over `fetch`, `undici`, `ky`, and the builtins, with or
without the `node:` prefix), database and LLM clients (49 rules over `pg`,
`mysql2`, `knex`, `@prisma/client`, `openai`, `@anthropic-ai/sdk`), pure
built-ins (36 methods), and in-place mutators (19 methods). Everything else is
`unknown`.

- **Only the packages named above are covered.** Drizzle, MongoDB, Redis, an S3
  client, a queue client, and any HTTP client other than `fetch`, `undici` or
  `ky` (`axios`, `got`) are `unknown`.
- **A client must be one a package's own types describe.** A client in a `const`
  initialized by `new <ImportedClass>(…)` or by an imported factory, held in a class field, passed
  as a parameter, or returned by an earlier call in a chain is recognized. A
  receiver whose type your project declares, the compiler's own lib declares, or
  an anonymous object type is `unknown`.
- **A builtin needs `@types/node`, not excluded by `types`.** A tsconfig with no
  `types` loads every installed `@types/*`. An explicit list is taken as written:
  `"types": []`, which `tsc --init` on 5.9.3 emits, leaves `node:fs` and the rest
  `unknown` (`AMB-W001`, not a violation).
  **Workaround:** add `"node"` to the list.
- **An opaque SQL statement costs both directions.** A `query` whose leading
  keyword the source does not fix contributes both `db_read` and `db_write`, so
  a read-only function that builds its statement dynamically has to declare
  `db_write`.

## Scale

**No incremental analysis is exposed.** Every `check` and `diff` run is a full
analysis: a re-check after a one-line edit costs what the first check cost.
Measured on this repository (43 files) on 2026-09-14, five runs each: `check
src` 1.31–1.75 s, `diff HEAD src` 2.18–2.95 s. Nothing has been measured at the scale of a large
application.

## Runtime hooks

Four hooks enforce `@capabilities` at run time: `installFetchHook()`,
`installFsHook()`, `installChildProcessHook()` and `installPgHook(pg)`. Each
returns the function that restores what it replaced.

### What is hooked, and at which version

| Hook | Target | Versions |
|---|---|---|
| `installFetchHook` | `globalThis.fetch` | the Node.js runtime Ambit supports (`engines.node`) |
| `installFsHook` | `node:fs`, `node:fs/promises` | same |
| `installChildProcessHook` | `node:child_process` | same |
| `installPgHook` | `pg`'s `Pool.prototype.query`, `Client.prototype.query` | `pg` 8.x — verified against `pg@8` in `test/e2e.runtime.test.ts` |

`installFsHook` checks named operations, not the whole module: `readFile`,
`readdir`, `access`, `stat`, `lstat`, `realpath`, `readlink`, `writeFile`,
`appendFile`, `mkdir`, `rmdir`, `rm`, `unlink`, `truncate`, `chmod`, `symlink`,
`rename`, `copyFile`, `link` and `open` (by its flags), in their callback, `Sync`
and `fs/promises` forms, plus `existsSync`. Streams are covered through `open`.
Any other `node:fs` function — `cp`, `opendir`, `watch`, `utimes`, `chown`,
`mkdtemp`, and the rest — is neither checked nor recorded.

Not hooked, and therefore neither blocked nor recorded: `mysql2`,
`@prisma/client`, `drizzle-orm`, `mongodb`, `openai`, `@anthropic-ai/sdk`, the
Vercel AI SDK, `node:http`/`https`/`net` (their effects are inferred statically
only), and every other client. Ambit cannot notice that an upstream release
moved a patch point; the `pg` row is a claim about the version tested
([`docs/open-questions.md`](open-questions.md)).

### Install order decides what a builtin hook covers

- **Installed from a preload** (`node --import ./ambit-hooks.mjs app.js`),
  before the application's module graph is linked, the hooks cover every form: `import { readFileSync } from "node:fs"`, `import fs
  from "node:fs"`, and `require("fs")`.
- **Installed from inside the module graph** — a call at the top of the entry
  module — they cover `fs.readFileSync()` through the default export and through
  `require("fs")`, but **not** a named import
  (`import { readFileSync } from "node:fs"`) or `import * as fs`, which are
  already bound to the original function: a builtin's ESM namespace is a
  snapshot taken when that builtin is first imported anywhere in the process.

Neither covers a native addon, code inside a child process, or another
`worker_threads` worker; a worker needs its own install.

### Node's own module loader reads through the hook

Node reads module sources with the public `fs.readFileSync`, so after
`installFsHook()` a `require()` or a dynamic `import()` is checked like any
other read. Under `setUnscopedPolicy("deny")`, or inside a context that grants
no `fs:read`, a lazily loaded module is denied.
**Workaround:** load what you need before installing the hook, or grant
`fs:read:` for the directories that hold the code.

### What a target can and cannot say

- **Paths** are resolved to absolute at the call, so a grant is an absolute path
  glob. `*` crosses `/`: `fs:read:/srv/app/*` also covers `/srv/app/a/b.txt`.
  There is no way to grant exactly one directory level.
- **File descriptors** carry no path. `fs.readSync(fd)` is not checked; the
  check happened at `open`. A descriptor obtained before the hook was installed
  is never checked.
- **A shell spawn names the shell.** `exec`, `execSync` and `shell: true` give
  `proc:spawn:/bin/sh` (or `options.shell`), so a grant for the shell permits any
  program the shell can start.
- **A `pg` target is the database, never a table.** The hook matches
  `db:read:<database>`, not `db:read:users`; table-level `db:` targets have
  meaning only in the static narrowing rule (`AMB-E005`). When the connection
  names no database, the requirement is `db:read:unknown`, which only
  `db:read:*` covers.
- **An opaque statement requires both directions.** A `query` whose leading SQL
  keyword is not readable — a `Submittable`, a config object without `text` —
  requires `db:read:` *and* `db:write:`.

## Framework adapters

Two adapters exist: `ambitHandler` from `ambit-ts/runtime/hono` and `ambitRoute`
from `ambit-ts/runtime/next`. Express, BullMQ, `worker_threads` and the rest have
none, and a handler they register establishes no Ambit context. Both adapters
enforce the capability set and `@budget` of the route they register, for the
handler and its `decode`, and the published package depends on neither `hono`
nor `next`.

| Adapter | Verified against | By |
|---|---|---|
| `ambit-ts/runtime/hono` — `ambitHandler` | `hono@4`, `@hono/node-server@1` | `test/runtime.hono.test.ts` in process, `test/e2e.runtime.test.ts` through a real server and a real socket, `test/e2e.install.test.ts` through the installed package |
| `ambit-ts/runtime/next` — `ambitRoute` | `next@16`, Node.js runtime only | `test/runtime.next.test.ts` — the exported Route Handler called directly with a real `NextRequest`, which is what Next.js does with it; `test/e2e.next-app.test.ts` for an `app/**/route.ts` project through `ambit check`; `test/e2e.install.test.ts` type-checks README's route and `instrumentation.ts` snippets against the installed package |

No test starts a `next` server process, so the Next.js adapter is verified as a
Route Handler function, not as a running application.

- **Only the routes it registers.** A route written without the adapter
  establishes no context; its operations are decided by `setUnscopedPolicy`
  (`allow` by default), not by the handler's JSDoc. Nothing scans for or reports
  an unwrapped route.
- **Middleware runs outside the context.** Middleware registered with `app.use`
  runs before and after the wrapped handler, so what it does is unscoped even
  when the route it fronts is wrapped.
- **A missing registration is "no context", not "no capabilities".** There is
  no contract lookup that can fail; the contract is the `spec` argument.
- **Errors are not HTTP statuses.** `AmbitCapabilityError` and
  `AmbitBudgetError` reach the framework's error handler (Hono's default: a bare
  500). Nothing maps them to 403 or 504, and the message — which names the
  granted set — is not put in a response body by Ambit.
- **The wrapped route returns a plain `Response`**, so Hono's RPC type inference
  (`hc`) sees `Response` rather than the handler's return shape.
- **`timeMs` includes `decode`**: time spent reading a request body counts
  against the budget.
- **Next.js: only `app/**/route.ts`, registered through `ambitRoute`.** Server
  Actions, `middleware.ts` and the Pages Router (`pages/api/*`) have no adapter
  and establish no context, so `setUnscopedPolicy` decides what they do —
  `allow` by default — and nothing reports them as unregistered.
- **The Edge runtime is not enforced.** A route that sets
  `export const runtime = "edge"` leaves the Node.js runtime, every hook is a
  Node.js hook, and the
  documented `register()` installs nothing unless
  `process.env.NEXT_RUNTIME === "nodejs"`. **No capability is checked on an Edge
  route**, and whether `ambitRoute` establishes a context there is unverified.
  Only the Node.js runtime is guaranteed in Phase 1
  ([`docs/open-questions.md`](open-questions.md), Edge runtimes). Leave an Edge
  route unwrapped rather than registering one that reads as enforced.
- **An adapted route does not survive `npm remove ambit-ts`.** JSDoc contracts
  are comments and survive removal (P5). An `ambitHandler(...)` or
  `ambitRoute(...)` call is an import from Ambit, so backing out means replacing
  each call with the framework's own handler.

## Backend

The analysis backend (`src/checker/backend/legacy-ts.ts`) is a connection layer
over the TypeScript compiler API and the adopted default (DESIGN.md §3.5,
ADR-0001). The conditions that would reopen that choice are in §3.5, and no
performance number is claimed for a backend that has not been run.
