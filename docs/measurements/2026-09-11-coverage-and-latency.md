# Coverage, latency and corpus history

Archived from `docs/status.md`. These are the per-change measurement runs that
produced the numbers `docs/status.md` now reports as a single current state:
the `unknown`-rate movement on Ambit's own source and on
`test/fixtures/realistic-api` change by change, the corpus results, and the
wall-clock figures.

Every number was run, not estimated. `docs/status.md` carries what is true now;
this file carries how it got there, and is not updated in place — a later
measurement is a later file.

## Promoting `ambit diff` to a gate

**`continue-on-error: true` is now removed.** What was missing was an approval
mechanism, and DESIGN.md §6.3 is it: `ambit.approvals.md`, read on both sides
of the comparison, so a line grants only in the comparison that adds it
([ADR-0008](adr/0008-approving-an-authority-increase.md)). Measured on this
change, which is itself a pull request that legitimately adds authority:
`diff HEAD src` reported five increases and exited 1 with no ledger, and exited
0 with the five approval lines written — the only difference between the two
runs being `ambit.approvals.md`. The five are `findApprovalsFile`,
`isProjectBoundary` and `loadApprovals` (`fs_read`, reading the ledger) and
`gitRaw` and `renamedFiles` (`process`, running `git diff --find-renames`).

Five lines is the honest cost of per-symbol granularity for a change of this
size: every new function that performs I/O is a new symbol holding authority.
A sixth was avoided rather than approved — `reviewIncreases` first reported
`state_write` for mutating an array retrieved from a local `Map`, which is the
mutation analysis being conservative about a value's provenance rather than a
defect (measured directly: `Map.set` on a locally created map is `pure`;
`map.get(k).push(x)` is `state_write`). Rewriting it to hold a cursor instead
of shifting the bucket made the function `pure` and removed the line.

`pnpm exec biome ci .` returns 1 in one local shell because of a
user-installed command wrapper, not because of this repository —
`pnpm exec biome --version` fails the same way. Run the binary directly
(`./node_modules/.bin/biome ci .`) to see the real exit code, which is 0. CI
runs `pnpm exec biome ci .` in GitHub Actions, where no such wrapper exists.

## Ambit's own source (`check src --coverage`)

| Figure | After the Hono adapter | Before `ambit.config.ts` | After `ambit.config.ts` | After M0.5 | After the CI gate | After the Next.js adapter | After the approval ledger |
|---|---|---|---|---|---|---|---|
| files analyzed | 27 | 27 | 29 | 29 | 29 | 30 | 39 |
| functions extracted | 194 | 202 | 236 | 238 | 246 | 248 | 302 |
| functions with a declared `@effects` | 4 | 4 | 4 (jsdoc 4, config 0) | 4 (jsdoc 4, config 0) | 4 (jsdoc 4, config 0) | 4 (jsdoc 4, config 0) | 14 (jsdoc 14, config 0) |
| `unknown` rate | 64.4% (125/194) | 63.4% (128/202) | 65.7% (155/236) | 66.0% (157/238) | 65.9% (162/246) | 66.1% (164/248) | **62.9% (190/302)** |
| `boundary` rate | 0.0% (0/194) | 0.0% (0/202) | 0.0% (0/236) | 0.0% (0/238) | 0.0% (0/246) | 0.0% (0/248) | 0.0% (0/302) |
| call sites | 1003 — resolved 299, stub 3, known-pure 258, mutation 94, unresolved 349 | 1035 — resolved 315, stub 3, known-pure 260, mutation 93, unresolved 364 | 1278 — resolved 404, stub 8, known-pure 327, mutation 110, unresolved 429 | 1287 — resolved 406, stub 8, known-pure 327, mutation 110, unresolved 436 | 1322 — resolved 419, stub 8, known-pure 341, mutation 110, unresolved 444 | 1335 — resolved 423, stub 8, known-pure 344, mutation 111, unresolved 449 | 1619 — resolved 542, stub 17, known-pure 423, mutation 138, unresolved 499 |
| unresolved by reason | `builtin-method` 68, `external-module` 265, `unresolved-symbol` 12, `callback-parameter` 4 | `builtin-method` 72, `external-module` 276, `unresolved-symbol` 12, `callback-parameter` 4 | `builtin-method` 102, `external-module` 307, `dynamic-import` 1, `unresolved-symbol` 15, `callback-parameter` 4 | `builtin-method` 102, `external-module` 314, `dynamic-import` 1, `unresolved-symbol` 15, `callback-parameter` 4 | `builtin-method` 107, `external-module` 317, `dynamic-import` 1, `unresolved-symbol` 15, `callback-parameter` 4 | `builtin-method` 108, `external-module` 318, `dynamic-import` 1, `unresolved-symbol` 16, `callback-parameter` 6 | `builtin-method` 138, `external-module` 337, `dynamic-import` 1, `unresolved-symbol` 17, `callback-parameter` 6 |
| skipped function-like nodes | 90 (`callback-argument` 75, `nested-function` 15) | 91 (`callback-argument` 76, `nested-function` 15) | 109 (`callback-argument` 91, `object-literal-method` 3, `nested-function` 15) | 109 (`callback-argument` 91, `object-literal-method` 3, `nested-function` 15) | 114 (`callback-argument` 96, `object-literal-method` 3, `nested-function` 15) | 116 (`callback-argument` 97, `object-literal-method` 3, `nested-function` 16) | 152 (`callback-argument` 133, `object-literal-method` 3, `nested-function` 16) |
| exit code | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

The last column is the current tree, measured on 2026-09-10 with `node
src/cli/main.ts check src --coverage`, exit code 0. It spans two changes, not
one: `ambit diff` itself was never added to this table, so the jump from 30
files to 39 is that command plus the approval ledger together. The `unknown`
rate is the first fall this table has recorded — 66.1% → 62.9% — because both
changes are `src/core/` and `src/cli/` code that calls almost nothing outside
Node's standard library, unlike the connection layer that drove every earlier
column upward. Ten more functions carry a declared `@effects` for the same
reason: `runDiff`, `git`, `gitRaw`, `renamedFiles` and the rest have to declare
what they do, because they are the parts of Ambit that run a subprocess.

The "After the CI gate" column added the call-path rendering,
`contract.operation`, and `--format github` — eight helper functions, all
undeclared, so the per-function `unknown` ratio moved by a tenth of a point.

The "After the Next.js adapter" column is the current tree: `src/runtime/next.ts`
is one more file and two more exported functions, both undeclared, plus the
adapter's inner arrows among the skipped nodes. Measured on 2026-09-10 with
`node src/cli/main.ts check src --coverage`, exit code 0.

CI gates on `node src/cli/main.ts check src --coverage --format github`,
without `--strict`. The baseline was measured, not assumed: plain `check src`
exits 0, and `check src --strict` exits 1 on four `AMB-W001` warnings —
`extractProject` (`src/checker/backend/legacy-ts.ts:55`), `loadProjectConfig`
(`:164`), `collectTsFiles` (`:211`), and `main` (`src/cli/main.ts:39`). All
four are the connection layer and the CLI reaching the `typescript` API and
`node:fs` through calls the analysis does not resolve; closing them is stub and
resolution work, not a contract to write, so `--strict` is not the gate today.
`check test/fixtures/realistic-api --strict` exits 1 for the same class of
reason (`unknown` 20.8%, 11/53 functions; `builtin-method` 1,
`ambient-declaration` 4). No allowlist was widened to make either number look
better.

The "After M0.5" column moved by two functions and
nothing else: `unwrapNonNullAssertions` and `implementationDeclarationOf`, both
added to `src/checker/backend/legacy-ts.ts` by the M0.5 fixes below, both
undeclared, both calling the `typescript` API (`external-module` 307 → 314).
The rate is a per-function ratio, so two more unknown connection-layer helpers
cost 0.3 points; no resolution got worse. Measured against commit `a39898c` in
the same session, by the same command, in a `git worktree` of that commit:
236 functions / 65.7% / 1278 call sites there, 238 / 66.0% / 1287 here.

`skippedFunctions` gained no `bodyless-declaration` entries because `src/`
contains no overload signature, `abstract` member, or `.ts`-file `declare`. That
is why the fix is invisible in this table and visible only in
`test/fixtures/backend-conformance`.

The three earliest columns (before and after DESIGN.md §4.2's local-mutation
rule: 19/163 and 21/176, and "after the runtime hooks": 64.2%, 124/193) are
dropped from the table to keep it readable; the paragraphs below still describe
those changes, and their numbers are in the git history of this file.

The last column is `src/` with `ambit.config.ts` implemented, measured on
2026-09-09 with `node src/cli/main.ts check src --coverage`. The
"before" column beside it is commit `5bdf48b` (the design commit), measured
the same way in the same session, so the two are comparable.

The `unknown` rate went 63.4% → 65.7% because the change added
`src/checker/config.ts` and `src/core/config.ts` — 34 more functions, almost
all undeclared, in a layer that calls the `typescript` API and Node's `fs` and
`path` (`external-module` 276 → 307, `builtin-method` 72 → 102). That is the
same accounting as the runtime-hook column described below: a per-function ratio pays
for every undeclared function added, and no resolution got worse. The
`dynamic-import` 1 is the loader's own `await import(configPath)` — Ambit
reports its own config loading as unanalyzable, which is correct.

`object-literal-method` 3 and `callback-argument` 76 → 91 are the new files'
inline arrows and object literals; `getter-setter` and
`anonymous-default-export` are absent from the breakdown for a different
reason — DESIGN.md §4.1 (a) gave them declaration paths, so they are extracted
now rather than skipped. `src/` contains none of either, so no function moved
between the two counts in this measurement.

The "After the Hono adapter" column is `src/` after `src/runtime/hono.ts`: one
more file, one more exported function, and two more skipped nodes (the
adapter's inner arrows). Measured on 2026-09-09 with `node
src/cli/main.ts check src --coverage`.

The "After the runtime hooks" column is `src/` after the four hooks were added
(`src/runtime/enforce.ts`, `fs.ts`, `child-process.ts`, `pg.ts`, and
`src/core/sql.ts`). The rate went from 63.1% to 64.2% because the hooks are
17 more mostly-undeclared functions in the connection-adjacent layers; that
is the same accounting the paragraph below describes, not a regression in
resolution.

The two columns dropped from the table above are DESIGN.md §4.2's
local-mutation rule ("Local mutation and `pure`") before and after. `builtin-method` unresolved dropped 131 → 62: 81 sites
became mutation sites, and `Array.push`, `Map.set` and `Set.add` left
`top-unresolved-names` entirely — every one of them is now either a local
mutation with no effect or a `state_write`. The two columns' denominators
differ because the change added two source files
(`src/stubs/mutating-builtins.ts`, and `src/core/summary.ts` gained its first
function) plus the locality helpers; `external-module` grew 221 → 257 for the
same reason, since those helpers call more of the `typescript` API. The rate
is a per-function ratio, so the added, mostly-unknown connection-layer helpers
work against it: the drop from 68.7% is what remains after paying for them.

Nothing in `src/` declares `state_write`, and nothing needed to: no declared
function in Ambit's own source mutates a value reachable from outside it, so
the change added no AMB-E001.

The remaining 64% unknown rate is dominated by `external-module` (264), which is almost
entirely calls into the `typescript` compiler API from the connection layer —
the one file that is meant to be replaceable. It is a real number, not a
target that has been met: `ROADMAP.md`'s goal is 30% for an *adopting team*
after three months, which no one has done.

It had gone **up** from 63.2% (86/136) before local mutation was decided —
measured before the client stubs and the capability work — because the
denominator grew by 27 functions whose helpers use `Array.push` and `Map.set`,
which the pure-builtin allowlist deliberately excludes. That is what §4.2's
decision addressed; the figure reached 63.1% then, marginally below the 63.2%
it started from. The current figure is 64.2%, for the reason the third column
of the table above records.

`String.slice`, which the same measurement surfaced at 8 occurrences, **was**
added to the allowlist afterwards — a missing non-mutating entry, and the exact
twin of the already-listed `Array.slice`. Its effect is visible only at the call
level: 8 sites moved from unresolved to known-pure (`builtin-method` 139 → 131,
known-pure 236 → 244). The function-level rate stayed at 68.7% (112/163),
because no function had `String.slice` as its *only* unresolved call. Nothing
else was added to the allowlist.

## Adopting-team-equivalent code (`check test/fixtures/realistic-api --coverage`)

`ROADMAP.md`'s `unknown`-rate target is about a team's own code, not about
Ambit's connection layer, so it is measured against
`test/fixtures/realistic-api` — a Node backend of the shape a coding agent
produces (HTTP handlers with `@entrypoint` contracts, a `pg` pool, a Prisma
client, a `mysql2` pool, two LLM SDKs, a barrel file, pure domain logic). **This is not a team**,
and it does not satisfy that target, which requires a real adopting team after three
months. It is the fixture that makes the number measurable at all.

| Figure | Before the client stubs | After the client stubs | After the runtime hooks | After factory clients are named |
|---|---|---|---|---|
| files analyzed | 9 | 9 | 16 | 16 |
| functions extracted | 19 | 19 | **51** | **53** |
| `unknown` rate | 47.4% (9/19) | 5.3% (1/19) | **21.6% (11/51)** | **1.9% (1/53)** |
| `boundary` rate | 0.0% | 0.0% | 0.0% | 0.0% |
| call sites | 31 — resolved 12, stub 1, pure 9, unresolved 9 | 31 — resolved 12, stub 8, pure 9, mutation 1, unresolved 1 | 74 — resolved 31, stub 10, pure 26, mutation 2, unresolved 5 | 77 — resolved 33, stub 13, pure 28, mutation 2, unresolved 1 |
| unresolved by reason | `builtin-method` 1, `unresolved-symbol` 8 | `ambient-declaration` 1 | `builtin-method` 1, `ambient-declaration` 4 | `ambient-declaration` 1 |
| top unresolved names | `Map.set` 1 | (none) | `ReadonlyArray.filter` 1 | (none) |
| exit code | 0 | 0 | 0 | 0 |

The middle column is where the fixture stood at 19 functions: the client
stubs took it from 47.4% to 10.5%, and DESIGN.md §4.2's local-mutation rule
then took it to 5.3% (1/19), because `putRate` in `src/lib/cache.ts` writes
into a module-scope `Map` and is now inferred as `state_write` rather than
left `unknown`.

The third column is the fixture after `mysql2` and `@anthropic-ai/sdk`
were added — a second database client and a second LLM SDK, plus the pure
domain code and the routes that use them — which is what makes 51 functions
a realistic backend rather than a padded one. The rate went **up**, from 5.3%
to 21.6%, and the reason it was recorded rather than smoothed over is that it
named the next thing to fix: `mysql2` hands out its pool through the
`createPool` factory, and a factory result had no module-qualified name for a
stub table to key on. The fixture uses the factory because that is how the
package is actually used.

The right-hand column is that gap closed. Measured against commit `186b819`,
which is the immediately preceding state and not the third column's tree (two
later changes had already taken it to 18.9% on 53 functions):

| | before (`186b819`) | after |
|---|---|---|
| `unknown` functions | 10 / 53 (18.9%) | **1 / 53 (1.9%)** |
| unresolved call sites | 4 | **1** |
| unresolved by reason | `ambient-declaration` 4 | `ambient-declaration` 1 |
| `top-unresolved-names` | (none — no name could be built) | (none — one unnameable call left) |
| stub call sites | 10 | **13** |

Nine of the ten `unknown` functions were the audit chain, and all nine came
from three call sites: `auditPool.query` and `auditPool.execute` in
`src/lib/mysql.ts`. A receiver bound by `const` to a call of an *imported*
function is now named by the module specifier the source wrote and the type
the callee is declared to return — `mysql2/promise.Pool` — which is the same
key shape `new Pool(...)` already produced for `pg`, reached by the other of
the two ways a package hands out a client. `src/stubs/data-clients.ts` gained
the four `mysql2/promise` rows those names need, read off
`mysql2@3.15.3/promise.d.ts`. Only that entry point: the callback API's
`createPool` is declared to return `BasePool`, not `Pool`
(`mysql2@3.15.3/typings/mysql/index.d.ts`), so no row covers it and it stays
`unknown` — recorded in `docs/limitations.md` rather than guessed at.

Naming is not resolving. Before the table rows were added, the three sites
were still `unresolved` — they had only stopped being anonymous, appearing as
`mysql2/promise.Pool.query=2, mysql2/promise.Pool.execute=1` in
`top-unresolved-names`. A package no bundled table covers gets the same
treatment: a name, and still `unknown`.

**The change found a wrong contract in the fixture itself.** `writeAudit`
declared `@effects db_write`; it calls `auditSize()`, which runs `SELECT
COUNT(*) AS total FROM audit`. The contract was green only because the whole
chain was `unknown` and nothing could contradict it. `check` now reports
`AMB-E001` for it, and the fixture's contract was corrected to `db_write,
db_read` (and the route's `ambitHandler` grant to match). That is the shape of
the product claim: the authority a route holds becomes visible, and
under-declaration stops being invisible.

**The analyzer change did not read as an authority increase.** `diff HEAD
test/fixtures/realistic-api` against the tree that made it reported the nine
audit functions as *unchanged* and named only two increases, both of them the
`writeAudit` contract correction above. Both sides are analyzed by the running
Ambit, so a change in the analysis cancels out — which is the property that
lets the analysis keep improving without the CI gate firing at everyone. `diff
HEAD src`, the shape CI runs, reported no increase at all and listed the three
new helpers under the newly-unresolved section, which exits 0.

**The corpus did not move, and that is expected.** `node
scripts/bench-corpus.ts` reports the same median, 52.6%, and the same
per-target rates as the table in "Real third-party code" below. The corpus
deliberately installs no dependencies, so a factory's return type is not
declared anywhere the checker can read — and the five targets are libraries
and frameworks, none of which holds a database client. The mechanism is
verified against real third-party *typings* (`mysql2@3.15.3`) rather than
against corpus code.

Five entries were added to the pure-builtin allowlist in the same
measurement — `ReadonlyArray.filter`, `ReadonlyArray.every`, `Math.max`,
`String.toLowerCase`, `String.toUpperCase`, each the twin of an entry already
there. Unresolved call sites went 10 → 5 and the rate 29.4% → 21.6%. The
allowlist now holds 36 methods.

**The one remaining `unknown` function, accounted for:**

| Function | File | Why |
|---|---|---|
| `fetchRate` | `src/lib/rates.ts` | `(await fetch(url)).json()` — the method is declared on a type from a `.d.ts`, and the pure-builtin allowlist covers only the compiler's own lib, so the call cannot be named (`ambient-declaration`) |

That is also the one unresolved call site. It is deliberate rather than
pending work: `docs/limitations.md` records that `Body.json` / `Response.json`
are left `unknown` because a `Response` body can be a socket, so the name
would not settle the effect even if one were built.

The nine that went, and what each now carries, all of it read back out of
`--format json`'s authority records rather than asserted:

| Function | File | Now |
|---|---|---|
| `recentAuditRows` | `src/lib/mysql.ts` | `db_read` — `mysql2/promise.Pool.query` on a literal `SELECT` |
| `appendAuditRow` | `src/lib/mysql.ts` | `db_write` — `mysql2/promise.Pool.execute` on a literal `INSERT` |
| `countAuditRows` | `src/lib/mysql.ts` | `db_read` — `mysql2/promise.Pool.query` on a literal `SELECT COUNT(*)` |
| `auditTrail` / `record` / `auditSize` | `src/lib/audit.ts` | inherited from the three above, witness path one hop long |
| `listAudit` / `writeAudit` / `reviewAudit` | `src/routes/audit.ts` | inherited two hops, each `paths[]` entry naming the operation and the file and line it sits on |

The direction came from the statement, not from the method name: the same
`Pool.execute` handed something the source does not fix contributes both
`db_read` and `db_write`, which `test/e2e.realistic.test.ts` asserts
separately from the literal case.

Functions that *call* an unknown function but declare their own contract —
`summarizeUsers` calling `fetchRate`, for one — are not themselves `unknown`:
a declared contract is what callers see. That is why the eleven above are the
undeclared helpers and the entrypoints that reach through them.

Before the client stubs, all eight of the `unresolved-symbol` calls were
database and LLM client methods, and none of them carried a name at all —
`top-unresolved-names` showed only `Map.set`. That is worth recording on its
own: the "what to stub next" signal was silent about the single largest source
of `unknown` in the fixture.

### Check latency

| Run | Wall clock |
|---|---|
| `check src`, five consecutive runs | 0.80 / 0.74 / 0.84 / 0.78 / 0.74 s |
| `check src` after changing one contract comment | 0.81 s |
| `check src`, five consecutive runs, 2026-09-09 (21 files, 176 functions) | 0.90 / 0.77 / 0.92 / 0.78 / 0.78 s |
| `check src`, five consecutive runs, 2026-09-09 after `ambit.config.ts` (29 files, 236 functions) | 1.35 / 0.94 / 0.87 / 0.93 / 0.98 s |
| `check src`, five consecutive runs, 2026-09-09 after M0.5 (29 files, 238 functions) | 1.24 / 0.88 / 1.17 / 0.99 / 1.02 s |
| `check src`, five consecutive runs, 2026-09-10 after `ambit diff` (37 files, 286 functions) | 1.14 / 1.04 / 1.05 / 1.04 / 1.21 s |
| `diff HEAD src`, five consecutive runs, 2026-09-10 (same tree, two analyses) | 2.56 / 2.06 / 1.99 / 1.83 / 1.97 s |
| `check src`, five consecutive runs, 2026-09-10 after the approval ledger (39 files, 302 functions) | 1.11 / 1.07 / 1.09 / 1.08 / 1.10 s |
| `diff HEAD src`, five consecutive runs, 2026-09-10 after the approval ledger (same tree, two analyses, one `git diff`) | 1.86 / 1.98 / 1.94 / 1.87 / 1.89 s |
| `check test/fixtures/realistic-api`, five runs, 2026-09-11, before naming factory clients | 0.46 / 0.40 / 0.41 / 0.40 / 0.41 s |
| `check test/fixtures/realistic-api`, five runs, 2026-09-11, after | 0.70 / 0.62 / 0.42 / 0.41 / 0.40 s |

The last pair was measured back to back in one session, the "before" side in a
`git worktree` of `186b819` sharing this tree's `node_modules`, because the
rows above it were taken on other days and cannot be compared against. The two
warm figures are the same; the extra `getTypeAtLocation` the receiver rule
costs is below what this measurement can see. `check src` was measured the same
way and is likewise indistinguishable — 1.26–1.37 s after against 1.52–1.78 s
before, which is the machine's noise floor, not a speedup, and no claim is made
from it.

The backend's share of that is now measured separately (the M0.5 section
above): 426 ms of program construction plus 110 ms of walking, on the same
tree. The rest is Ambit's own summarizing, propagation and diagnostics, plus
Node's type stripping of the whole source tree on every start.

The re-check costs the same as the first check because **nothing is cached**.
DESIGN.md §6.2's resident/incremental path is not implemented, so "the
initial check" and "the re-check after a change" are the same operation.
That is the honest reading of these numbers, and the reason no threshold
has been set: there is nothing yet to compare against.

Every row is labelled with the tree it was measured on. The last two rows are
the current tree; the rows above them are smaller trees and are kept as
recorded, not restated for this build.

The approval ledger costs nothing measurable. It adds one `git diff
--find-renames` and two reads of a small file to a command that already runs
two whole analyses, and `diff` on the current tree is not slower than the
larger-tree row above it.

`diff` costs about twice a `check`, and that is the whole of it: the base ref
is a fresh `git worktree` and both sides run the same analysis from scratch.
No cache is involved — DESIGN.md §6.2's resident path is still not
implemented, and this command does not open that question.

The first two rows are the original measurement and have **not** been
superseded; the two 2026-09-09 rows are later five-run measurements on the same
machine, and 0.87–1.35 s is the range README quotes. The first run of the last
row is the slowest of the five and is left in: nothing warms a cache between
them, so a one-off high reading is the measurement, not noise to discard. Re-running the same command while adding the client stubs gave 1.72–3.20 s, and
re-running it on the pre-change tree in the same session gave 2.58–3.63 s —
both far above the recorded range, and the older tree the slower of the two.
That is machine load, not a change in the analysis, and neither range is
recorded as a figure for this build. A comparable measurement needs a quiescent
machine, and §3.5's performance gate has not run either way.

### Test suite wall time

CI's `Test` step (`pnpm test`, GitHub Actions `ubuntu-latest`, run
34429851250) took 173 s of a 194 s job — the whole test suite ran serially
(`vitest.config.ts` set `fileParallelism: false`) and spawned the CLI as a
subprocess close to 100 times with no compile cache.

Three changes removed those costs: memoizing `legacyTsBackend.extractProject`
per fixture root within a test file (`test/support/extract.ts`), setting
`NODE_COMPILE_CACHE` for every spawned `node` process (`vitest.config.ts`
`test.env`), and restoring `fileParallelism` behind a cross-process lock
around `pnpm pack` (`test/support/global-setup.ts`, `test/support/pack.ts`).
None of them touch analysis — `check src --coverage`'s `unresolved-by-reason`
breakdown is unchanged before and after.

Measured on the same machine as the M0.5 section below (`vitest run`, 412
tests, 27 files, all passing at every step):

| Configuration | Wall clock |
|---|---|
| Before (serial, no compile cache, no fixture memo) | 133 s |
| + fixture-extraction memo, serial | *(see per-file note below)* |
| + `NODE_COMPILE_CACHE`, still serial | 107 s |
| + `fileParallelism` restored (all three changes) | 37 / 43 s |

The fixture memo's own effect is clearest per-file rather than suite-wide: the
five files it touches (`backend.legacy-ts.test.ts`, `contracts.test.ts`,
`diagnose.test.ts`, `construction.test.ts`, `mutation.test.ts`) went from
26.9 s combined to 5.95 s combined, run in isolation before the other two
changes landed.

CI itself confirms the direction, at a smaller margin than the 8-core local
numbers above: on PR #17's own run (`ubuntu-latest`, 4 vCPU, run
34432888258), the `Test` step went from 173 s to **86 s**, and the whole job
from 194 s to **113 s**. `ubuntu-latest`'s 4 vCPU makes the CLI-spawn-heavy
part of this suite more CPU-bound than the 8-core machine above, which is
exactly why the ratio is smaller here (2.0x) than locally (3.2–3.6x) — both
numbers are real, they are just answering different questions about
available parallelism.

## Real third-party code (`node scripts/bench-corpus.ts`)

`test/fixtures/realistic-api` is code written for this repository, so it can
only say that the analysis works on the shapes it was given. The fixed corpus
in `test/corpus/corpus.json` is code nobody here wrote: five server-side
TypeScript projects, pinned by commit SHA **and** by the git tree object of the
measured subtree, so the benchmark fails loudly rather than quietly measuring a
different checkout.

```sh
node scripts/bench-corpus.ts
```

One command checks the corpus out into `.corpus/` (gitignored) and reports
`docs/DESIGN.md` §4.3's primary KPI per target and across targets. It runs the
analysis through the library API rather than through `ambit check`, because
picking the next thing to work on needs the whole unresolved-name histogram
while `--coverage` prints the top ten — widening the CLI's output would be a
change to §9.2's guaranteed surface for the sake of a measurement procedure.

**Dependencies are deliberately not installed.** A call into a package whose
types are absent stays unresolved, so the measurement can only be pessimistic
about third-party code, never flattering — at the cost of an `any-typed` count
(1067 sites) that an adopting team with a populated `node_modules` would not
see. That is a property of this corpus, not of the analysis.

| Target | Subtree | Functions | `unknown` rate, before | after |
|---|---|---|---|---|
| `hono` | `src` | 644 | 78.4% | **52.6%** |
| `trpc-server` | `packages/server/src` | 196 | 82.1% | **59.7%** |
| `elysia` | `src` | 352 | 76.7% | **51.7%** |
| `got` | `source` | 357 | 67.2% | **54.6%** |
| `drizzle-orm` | `drizzle-orm/src` | 2651 | 45.5% | **39.0%** |
| **median** | | 4200 | **76.7%** | **52.6%** |

"Before" is commit `fc1bcc9`, which fixed the corpus and recorded the baseline
before any analyzer change. `ROADMAP.md`'s target is 30% for an adopting team
after three months; **this corpus does not meet it**, and no target here is an
adopting team.

What moved the number, in the order the measurement said to take it:

| Change | median |
|---|---|
| baseline | 76.7% |
| default-lib classification (`pure-builtins.ts`, `mutating-builtins.ts`, `builtin-effects.ts`, Fetch API constructors) | 55.7% |
| by-reference callbacks resolved from the actual argument (§4.2 rule 4) | 54.5% |
| calls to a function whose body this summary already walked (`inlined`) | 54.0% |
| the locality rule applied to argument-position mutators (`Object.assign`) | 52.6% |

The same changes take `check src --coverage` from 62.9% to **37.9%**
(120/317 functions; the denominator grew from 302 with the helpers the changes
added) and `check test/fixtures/realistic-api --coverage` from 20.8% to
**18.9%** (10/53). (An earlier revision of this line read 37.3% (117/314); that
was recorded before the last three helpers landed and does not reproduce at the
commit that wrote it. The number above is what `check src --coverage` prints.)

Naming factory-created clients left the corpus median at 52.6% and every
per-target rate unchanged — see "Adopting-team-equivalent code" above for why
this corpus cannot show the change. On `check src --coverage` it reads 38.1%
(123/323): the three helpers it added are themselves undeclared functions
calling the TypeScript API, so the whole movement is +25 call sites,
+15 `external-module`, and +3 functions of its own code. The `builtin-method`
count held at 13 and `pure` went 560 → 561, which is the counter that would
have fallen had the new receiver name taken anything off
`src/stubs/pure-builtins.ts`.

### Why the corpus does not install its dependencies

The manifest's "dependencies are deliberately not installed" is a measured
decision, not a convenience. Four targets were checked out a second time
outside `.corpus/`, installed with the package manager and lockfile each
repository pins, and measured again:

| Target | no install | installed | external-module calls that can be named |
|---|---|---|---|
| `got` | 54.6% | **54.6%** | 145 / 190 |
| `hono` | 52.6% | **52.6%** | — (no runtime dependencies) |
| `elysia` | 51.7% | **51.1%** | 16 / 203 |
| `trpc-server` | 59.7% | **57.7%** | 6 / 54 |
| `drizzle-orm` | 39.0% | — | — |

Installing moves the unresolved *reason* and leaves the rate where it was: on
`got`, `unresolved-symbol` 308 → 103, `import-binding` 35 → 20 and `any-typed`
287 → 237, while `external-module` goes 0 → 190. The calls do not become
analyzable; they become third-party calls, which need a stub.

Whether a stub can be written for them is decided by whether the connector
layer can name the call at all, and that varies by API shape rather than by
package. A named import called directly (`is.string(value)`) is named;
a fluent chain (`t.Object({}).Encode()`) has a call result as its receiver, and
`qualifiedNameOf` produces nothing for it. Hence 76% nameable on `got` against
8% on `elysia`.

`drizzle-orm` could not be installed at all: its lockfile pins
`drizzle-kit-0.25.0-b1faa33.tgz`, which the registry now answers 404 for. A
lockfile is not by itself a reproducible input — a tarball can be unpublished
after the fact — so making the benchmark depend on one would trade a
measurement that reproduces today for one that stops reproducing on someone
else's schedule.

### Why 30% is not reachable on this corpus

Counting unresolved *call sites* stops being useful once a function reaches
several of them: what decides the KPI is how many functions have **no**
unresolved call left. Re-running the propagation with one whole reason category
treated as fully resolved gives the ceiling each category can buy, and no
category is close to enough on its own:

| Hypothesis | median |
|---|---|
| as measured | 52.6% |
| every `builtin-method` site resolved | 48.9% |
| every `unresolved-symbol` site resolved | 48.6% |
| every `callback-parameter` site resolved | 49.4% |
| every `any-typed` site resolved | 42.0% |
| `any-typed` **and** `import-binding` resolved — the upper bound for installing the corpus's dependencies | 40.6% |
| those **plus** every `unresolved-symbol` site | 34.4% |
| every unresolved site of every kind resolved | 5.9% |

The row that matters is the second-to-last. Installing the dependencies — the
one lever that is not an analysis improvement at all — would leave the median at
**40.6%** even if every resulting call then resolved perfectly, which it would
not. Reaching 30% needs three whole categories eliminated at once, and two of
them (`any-typed`, `callback-parameter`) are not things a stub table or a
resolution rule can answer: the first is a call through a type the compiler has
given up on, the second is a higher-order function calling its own parameter,
which §4.2 rule 4 leaves `unknown` without per-call-site specialization.

What is left is mostly not addressable by a table. Of 3781 unresolved call
sites: `unresolved-symbol` 1397 (a call to a nested function no longer counts here — its
body is walked into the caller's summary and the site is tallied as `inlined`
— but the nested function still has no id of its own, §12's "Nested function
declarations and the locality rule"), `any-typed` 1067 (the uninstalled-dependency cost above),
`builtin-method` 543, `callback-parameter` 432 (a higher-order function calling
its own parameter, which §4.2 rule 4 leaves `unknown` without inter-procedural
argument tracking), `overload-without-body` 175, `import-binding` 134.

The 543 remaining `builtin-method` sites are the names the tables refuse on
purpose, and they are worth naming because a reader will otherwise assume they
were missed: the `ReadableStream`
controllers and readers, `Body.json` / `Response.json` (about 120 together)
depend on what the object is backed by; `console.*` (45) writes to a stream
§4.2's effect table has no name for. Each is `unknown`, which is the honest
answer, not an oversight.

### How much of the `unknown` a reader can be told about

`ambit init` proposes nothing for a function that reached `unknown` (§4.1), so
until `AMB-I002` those functions carried no information at all. How many of them
hold the unresolvable call *themselves* — the ones a report can point at,
rather than the ones that merely inherited `unknown` from a callee — was
measured over the same corpus, on the same pinned checkouts:

| Target | undeclared and `unknown` | holds its own unresolved call | inherited only |
|---|---|---|---|
| `hono` | 339 | **234** | 105 |
| `trpc-server` | 117 | **100** | 17 |
| `elysia` | 182 | **142** | 40 |
| `got` | 195 | **143** | 52 |
| `drizzle-orm` | 1035 | **549** | 486 |

Counted over `propagate`'s result, per function: undeclared (`declared.kind ===
"none"`), not `@boundary`, `observed.unknown`, and — for the middle column —
`summary.calls.some(callLeavesUnknown)`. Same extraction and propagation as
`scripts/bench-corpus.ts`, over the same checkouts it pins.

The middle column is what `AMB-I002` reports on; the last is deliberately left
silent, because the leaf that holds the call is already reported and saying it
again once per caller is not information. None of this moves the `unknown`
rate — no contract is proposed and none is inferred. `check src --coverage`
after the change is **37.5%** (120/320): the same 120 `unknown` functions as
before, over a denominator three larger, being the three resolvable helpers the
change added to `src/checker/init.ts`. It is a diagnostic id, so it is a §9.2
change with a `CHANGELOG.md` entry. The reasoning for carrying no fix is
[ADR-0011](adr/0011-reporting-why-a-contract-cannot-be-proposed.md).

One behavioural consequence worth flagging: `Date.now()` and `Math.random()`
now carry `env` rather than `unknown`, so a caller declaring `@effects pure`
that reads the clock moves from `AMB-W001` to `AMB-E001` — an error, and a
non-zero exit. That is what §4.2 says (the clock and randomness are `env`) and
what `new Date()` already did. It is an added stub, so it is not a change to
§9.2's guaranteed surface and carries no `CHANGELOG.md` entry.

