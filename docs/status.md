# Implementation status against the milestones

Where the code stands against `ROADMAP.md`'s milestones. This file
records *implementation status*, not design — the specification itself is
`docs/DESIGN.md`, and nothing here changes it.

Measured on 2026-09-09, Node.js v24.20.0, macOS (darwin arm64), Apple M1,
8 cores, 16 GiB. Every number below was run, not estimated.

**Verdict: publishable as 0.1.0; not a 1.0.** M0.5 is complete — all five
gates ran, and the default backend is decided (DESIGN.md §3.5, ADR-0001: the
legacy TypeScript Compiler API). M1 still has no incremental path, and M2–M4
are partial. The details are per row.

What 0.1.0 asserts is DESIGN.md §9.2's guaranteed surface under semver's 0.x
rule: a breaking change to it may land in a minor release (§9.3) and is
announced in `CHANGELOG.md`. It is not the stability a 1.0 would claim, and
nothing here is measured against a real adopter — the Phase 1 exit criterion
(M5) is untouched.

As of this measurement the package is **not on the registry**. The manifest is
`0.1.0` and no longer `private`, `npm pack --dry-run` produces the intended
tarball, and the release workflow exists; the publish itself is a manual step
a human runs, for the reason `.github/workflows/release.yml` records.

## Baseline commands

Re-run on 2026-09-10 against the `0.1.0` manifest. The counts and exit codes
below are from that run; the wall-clock figures elsewhere in this file are from
the 2026-09-09 measurement and were not re-taken.

```sh
pnpm test                     # 455 tests, 29 files — pass
pnpm exec tsc --noEmit        # pass
./node_modules/.bin/biome ci .  # pass
node src/cli/main.ts check src --coverage   # exit 0
node src/cli/main.ts check test/fixtures/realistic-api --coverage   # exit 0
node src/cli/main.ts check test/fixtures/next-app --coverage         # exit 0
node src/cli/main.ts diff HEAD src           # exit 0 with the ledger's five approvals in place
npm pack --dry-run            # ambit-ts-0.1.0.tgz, 96 files, 161.8 kB packed / 536.4 kB unpacked
```

`check src --coverage` breaks its unresolved calls down as
`builtin-method=138, external-module=337, dynamic-import=1,
unresolved-symbol=17, callback-parameter=6` — unchanged by the release
metadata, which is the point of quoting it here.

The tarball is `dist/` (90 files) plus six: `README.md`, `LICENSE`,
`CHANGELOG.md`, `docs/diagnostics/README.md`, `docs/limitations.md`, and
`package.json`. `docs/DESIGN.md`, `scripts/`, `test/` and `.m05-native/` are
outside it — `test/architecture.test.ts` asserts the last two. `dist/` carries
no `.js.map` or `.d.ts.map`: a map is only useful beside the sources it points
at, and `.ts` cannot ship (Node refuses to strip types under `node_modules`),
so every map would have resolved to a file the tarball does not contain.
Dropping them took the tarball from 186 files / 208.3 kB to the figures above.

The M0.5 comparison is a separate, manual procedure — it spawns a Go engine and
takes wall-clock measurements, neither of which belongs in CI:

```sh
node scripts/m05-native-install.ts                  # into .m05-native/ (gitignored)
node scripts/m05-corpus.ts .m05-corpus 300          # the 300-file scale corpus
node scripts/m05-backend-compare.ts --corpus <dir> --runs 5
node scripts/m05-update-correctness.ts
node scripts/m05-probe/native-primitives.ts test/fixtures/backend-conformance
```

`.github/workflows/ci.yml` runs `ambit diff HEAD~1 src --format github` as a
**gating** step, and `actions/checkout` is given `fetch-depth: 0` so the
history exists locally — the default of 1 would make `HEAD~1` unresolvable,
and `test/e2e.diff.test.ts` additionally resolves a pinned SHA, which a shallow
clone of any fixed depth would eventually not reach. On a `pull_request` event
`HEAD~1` is the base tip, so the comparison is main against the pull request's
tree — the comparison the step is for.

It ran non-gating once before the ledger existed, on the pull request that
introduced `ambit diff`
([run 34429541730](https://github.com/sano-suguru/ambit/actions/runs/34429541730)):
the step exited 1 and emitted 16 annotations naming the eight symbols the
`diff` command itself added, each with its call path, and the job stayed green
only because of `continue-on-error`.

### Promoting `ambit diff` to a gate

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

| Figure | Before the client stubs | After the client stubs | After the runtime hooks |
|---|---|---|---|
| files analyzed | 9 | 9 | 16 |
| functions extracted | 19 | 19 | **51** |
| `unknown` rate | 47.4% (9/19) | 5.3% (1/19) | **21.6% (11/51)** |
| `boundary` rate | 0.0% | 0.0% | 0.0% |
| call sites | 31 — resolved 12, stub 1, pure 9, unresolved 9 | 31 — resolved 12, stub 8, pure 9, mutation 1, unresolved 1 | 74 — resolved 31, stub 10, pure 26, mutation 2, unresolved 5 |
| unresolved by reason | `builtin-method` 1, `unresolved-symbol` 8 | `ambient-declaration` 1 | `builtin-method` 1, `ambient-declaration` 4 |
| top unresolved names | `Map.set` 1 | (none) | `ReadonlyArray.filter` 1 |
| exit code | 0 | 0 | 0 |

The middle column is where the fixture stood at 19 functions: the client
stubs took it from 47.4% to 10.5%, and DESIGN.md §4.2's local-mutation rule
then took it to 5.3% (1/19), because `putRate` in `src/lib/cache.ts` writes
into a module-scope `Map` and is now inferred as `state_write` rather than
left `unknown`.

The right-hand column is the fixture after `mysql2` and `@anthropic-ai/sdk`
were added — a second database client and a second LLM SDK, plus the pure
domain code and the routes that use them — which is what makes 51 functions
a realistic backend rather than a padded one. The rate went **up**, from 5.3%
to 21.6%, and the reason is the point of recording it: `mysql2` hands out its
pool through the `createPool` factory, and a factory result has no
module-qualified name for a stub table to key on (see
`docs/limitations.md`, "The database and LLM client table": a client
"returned by a factory is not matched and reports `unknown`"). The fixture uses the factory
because that is how the package is actually used.

Five entries were added to the pure-builtin allowlist in the same
measurement — `ReadonlyArray.filter`, `ReadonlyArray.every`, `Math.max`,
`String.toLowerCase`, `String.toUpperCase`, each the twin of an entry already
there. Unresolved call sites went 10 → 5 and the rate 29.4% → 21.6%. The
allowlist now holds 36 methods.

**All eleven remaining `unknown` functions, accounted for:**

| Function | File | Why |
|---|---|---|
| `recentAuditRows` | `src/lib/mysql.ts` | calls `auditPool.query`, and `auditPool` came from `createPool(…)`; a factory result has no module-qualified name (`ambient-declaration`) |
| `appendAuditRow` | `src/lib/mysql.ts` | same, through `auditPool.execute` |
| `countAuditRows` | `src/lib/mysql.ts` | same, through `auditPool.query` |
| `auditTrail` | `src/lib/audit.ts` | calls `recentAuditRows`, which declares no contract, so the unknown propagates |
| `record` | `src/lib/audit.ts` | same, through `appendAuditRow` |
| `auditSize` | `src/lib/audit.ts` | same, through `countAuditRows` |
| `listAudit` | `src/routes/audit.ts` | reaches the same unresolved call through the undeclared audit layer (`AMB-W001`, `AMB-W003`) |
| `writeAudit` | `src/routes/audit.ts` | same |
| `reviewAudit` | `src/routes/audit.ts` | same |
| `fetchRate` | `src/lib/rates.ts` | `(await fetch(url)).json()` — the method is declared on a type from a `.d.ts`, and the pure-builtin allowlist covers only the compiler's own lib, so the call cannot be named (`ambient-declaration`) |
| `backorderedSkus` | `src/domain/inventory.ts` | `levels.filter(isBackordered)` passes a callback *by reference*; DESIGN.md §4.2 rule 4 refuses a pure verdict from the method name alone even though `ReadonlyArray.filter` is on the allowlist (`builtin-method`) |

That accounts for the five unresolved call sites too: three `mysql2` calls
and one `.json()` are the four `ambient-declaration`s, and the callback-by-
reference `filter` is the one `builtin-method`.

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

The same changes take `check src --coverage` from 62.9% to **37.3%**
(117/314 functions; the denominator grew from 302 with the helpers the changes
added) and `check test/fixtures/realistic-api --coverage` from 20.8% to
**18.9%** (10/53).

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

One behavioural consequence worth flagging: `Date.now()` and `Math.random()`
now carry `env` rather than `unknown`, so a caller declaring `@effects pure`
that reads the clock moves from `AMB-W001` to `AMB-E001` — an error, and a
non-zero exit. That is what §4.2 says (the clock and randomness are `env`) and
what `new Date()` already did. It is an added stub, so it is not a change to
§9.2's guaranteed surface and carries no `CHANGELOG.md` entry.

## M0.5 — the backend comparison, measured

Every number here was run on 2026-09-09, Node.js v24.20.0, macOS (darwin
arm64), Apple M1, 8 cores, 16 GiB, from this repository. The procedure is
`scripts/m05-backend-compare.ts`, `scripts/m05-update-correctness.ts`,
`scripts/m05-corpus.ts` and `scripts/m05-probe/native-primitives.ts`; the
decision they led to is DESIGN.md §3.5, recorded in ADR-0001. An earlier,
partial evaluation preceded all of this and its numbers are superseded by
everything below; it is kept at the end of this section, under "The preliminary
evaluation (superseded)".

Two things in this section were corrected after first being written, and both
corrections are kept in place rather than edited out: gate 2's cause (it is
TypeScript 6's behaviour, not the Go port's) and the version on the legacy side
(5.9.3 was a scaffolding default; 6.0.3 was measured and adopted). Each is
recorded where it belongs below.

**The candidates.** `typescript` through the Compiler API, as
`src/checker/backend/legacy-ts.ts` uses it — the comparison ran against 5.9.3,
which is what the repository was pinned to, and 6.0.3 was measured afterwards
(see "The version within the adopted line" below) and adopted. And `typescript`
7.0.2 — npm's `latest` — through `typescript/unstable/sync`, a JavaScript
client talking to a Go engine in a child process. Oxc was not carried forward
from the preliminary evaluation: it is a parser, and §3.5 gate 4 forbids
comparing parsing against type-aware analysis. Nothing was measured for a
backend that did not run.

**The preliminary evaluation's blocker is gone.** It recorded the Go engine
failing at `/proc/self/exe` before initializing. That was environment-specific: the same
distributed 7.0.2 starts on this machine, opens a project, and answers symbol,
type and JSDoc queries. Everything below is therefore a first measurement, not
a repetition — and Linux was **not** re-verified here.

### Gate 1 — API conformance

`test/backend.conformance.test.ts` (28 tests, in `pnpm test`) is the permanent
half. It asserts against the `TsBackend` interface rather than against a
compiler, so a second implementation is judged by the same assertions, and it
covers the shapes §3.5 names that `test/backend.legacy-ts.test.ts` did not:
generic, overload, union, `any` vs. the non-null assertion, recursion, JSDoc
tag *locations*, and Unicode positions. Aliased import, re-export and callback
were already covered there and are not duplicated.

**It found a release-blocking defect in the current tree, and the defect is
backend-independent.** An overload set is several declarations under one
declaration path, and all of them were extracted. Two consequences:

- `propagate` keyed its state by `SymbolId` and iterated the summaries array.
  Two entries sharing an id overwrite each other every pass, so `changed` never
  goes false. `ambit check` on a file with an overloaded function whose
  implementation contains any call **does not terminate** — verified by
  `timeout 15 node src/cli/main.ts check <dir>` returning 124 on a seven-line
  fixture (two signatures, an implementation calling `fetch`, and one caller),
  and by `test/backend.conformance.test.ts`'s fixed-point test. An overload set
  whose implementation calls nothing does not hang, which is why `src/` never
  showed it.
- A call to an overloaded function resolved to `declarations[0]`, the first
  bodyless *signature*. A bodyless declaration infers an empty effect set, so a
  caller of an overloaded `fetch` wrapper read as `pure`. For an overload set
  with no implementation at all (`declare function`), that was the only outcome.

Fixed: only the implementation is extracted (`bodyless-declaration` is a new
`SkippedFunctionKind`), calls resolve to the implementation, an overload set
with no implementation is `overload-without-body`, and a contract written on a
bodyless signature is AMB-E003 instead of being silently dropped. The rule is
DESIGN.md §4.1 "Overloads and bodyless declarations";
`ExtractedFile.functions` now states id-uniqueness as a backend requirement,
because `propagate`'s termination argument rests on it.

A second, smaller defect the same suite found: `f!()` reported
`unresolved-symbol` where `f?.()` reported `callback-parameter`, because the
`NonNullExpression` wrapper hid the parameter declaration. DESIGN.md §12
requires `as any` and `!` to be told apart, and this told them apart in the
wrong direction — `!` was costing more information than the cast. Fixed by
unwrapping the assertion before resolving the callee; `(f as any)()` still
reports `any-typed`, and the conformance suite now pins both.

**Native, on the same fixtures.** `node scripts/m05-probe/native-primitives.ts
test/fixtures/backend-{smoke,conformance}` — no blocker, but not free either:

| Primitive Ambit needs | 7.0.2 |
|---|---|
| `getSymbolAtLocation`, `getAliasedSymbol`, `getTypeAtLocation`, `getResolvedSignature`, `getShorthandAssignmentValueSymbol`, `getImmediateAliasedSymbol` | present, with batch overloads |
| `isSourceFileDefaultLibrary` / `isSourceFileFromExternalLibrary` | present |
| JSDoc tag **locations** | present — `getJSDocTags(node)` returns AST nodes with `pos`/`end`, and `getLineAndCharacterOfPosition` documents UTF-16 code units. Verified: `@effects fs_read` on `recursion.ts#leafReadsFile` at line 5, cols 5–22 — the same range `test/backend.conformance.test.ts` asserts for legacy |
| Unicode positions | correct. On the astral line of `unicode.ts`, native reported character 25, where UTF-16 says 25, UTF-8 bytes say 29 and code points say 23 |
| overload declaration structure | identical — `widen` reports 3 declarations, `sig,sig,impl`, and `getJSDocTags` reads the tag off a bodyless signature |
| `getFullyQualifiedName` | **absent.** `pureBuiltinName` (`"Set.has"`) and the `builtin-method` / `external-module` split depend on it. Reconstructable from the symbol parent chain — `Set -> has` was verified for a default-lib method — but only one shape was checked |
| `ts.isGetAccessor` / `isSetAccessor` / `isClassLike` | renamed, not missing: `isGetAccessorDeclaration`, `isSetAccessorDeclaration`, `isClassLikeDeclaration` |
| `ts.forEachChild` as a module export | absent; it is a method on `Node` instead |

### Gate 2 — existing-code compatibility

**This is the gate native failed.** TypeScript 7.0.2 does not include
`node_modules/@types/*` automatically; 5.9.3 does. Isolated by bisecting a
tsconfig down to `{}` and back up: every configuration fails on 7.0.2 until
`"types": ["node"]` is named explicitly. It is not a pnpm artifact — a clean
`npm install @types/node@24` in a scratch directory reproduces it — and it is
not about `node:` specifiers: unprefixed `path`, and the `process` and `Buffer`
globals, fail the same way. A package that ships its own `.d.ts` (`hono@4`)
resolves on both.

Measured on this repository, same `tsconfig.json`, both compilers invoked by
explicit path:

| | 5.9.3 | 7.0.2 |
|---|---|---|
| `tsc --noEmit` on `src/` + `test/` | 0 errors | **198 errors**, all TS2591 |
| calls resolved in `src/` (gate-4 probe) | 1,212 of 1,213 | 1,143 of 1,213 |
| of which classified `external` | 325 | 267 |

The 69-call gap is what the analysis loses, not just what the type checker
complains about: 58 of the 69 are `external`, which is where the stub table
matches `node:fs` and friends to known effects. Those calls become `unknown`.

**This gate was first written up as the reason native lost. That was wrong, and
the correction matters more than the original finding.** The behaviour is not a
property of the Go port — it is TypeScript 6's. `typescript@6.0.3`, the
JavaScript implementation, does exactly the same thing:

| | 5.9.3 | 6.0.3 | 7.0.2 |
|---|---|---|---|
| `node:path` import, no `types` field | OK | TS2591 | TS2591 |
| the same, with `"types": ["node"]` | OK | OK | OK |
| `tsc --noEmit` on this repository | 0 errors | 198 errors → 0 with the line | 198 errors |

So it could not be counted against the native engine, and DESIGN.md §3.5
withdraws it as a reason. The decision itself did not change; its stated basis
did. The lesson is narrower than the finding: a difference measured against one
version of one implementation is not yet a property of that implementation.

The tsconfig surface differs by version in both directions, and 6.0.3 sits
between as the deprecation bridge (each row run through all three compilers on
the same file):

| tsconfig option | 5.9.3 | 6.0.3 | 7.0.2 |
|---|---|---|---|
| `esModuleInterop` | accepted | accepted | accepted |
| `baseUrl`, `downlevelIteration` | accepted | TS5101 "deprecated and will stop functioning in TypeScript 7" | TS5102 "has been removed" |
| `importsNotUsedAsValues` | accepted | accepted | TS5023 "unknown compiler option" |
| `stableTypeOrdering` | TS5023 "unknown" | accepted | accepted |
| `deduplicatePackages` | TS5023 "unknown" | TS5023 "unknown" | accepted |

The last two rows are a cost of the decision, not a point in its favour: a
tsconfig naming `deduplicatePackages` is one that Ambit's analyzer refuses to
start on. DESIGN.md §12 "TypeScript version compatibility" holds it.

### Gate 3 — update correctness

`node scripts/m05-update-correctness.ts`. One change at a time in a throwaway
copy of `test/fixtures/backend-conformance`, checked at the backend level. This
is not M1's resident checker and does not implement one.

| Change | legacy | native, told (`fileChanges`) | native, not told |
|---|---|---|---|
| function body — a new `fetch` call appears | reported | reported | **stale** |
| contract comment only — `@effects fs_read` → `network` | reported | reported | **stale** |
| export — `leafReadsFile` stops being exported | reported | reported | **stale** |
| re-query latency | 214 / 264 / 272 ms | 1.0 / 1.0 / 1.9 ms | — |

Both are correct when told. The asymmetry is what happens when they are not:
`ambit check` builds a fresh `ts.Program` every run, so the legacy path cannot
go stale — and cannot go fast, which is exactly what §6.2 exists to fix. The
native snapshot answers from its previous state and **reports no error while
doing so**; a contract-comment change simply does not exist. Adopting it means
owning file-change tracking correctly on pain of turning a violation into a
clean run, which DESIGN.md §3.4 forbids.

`ambit.config.ts` and stub changes are not in the table on purpose. Both are
read by Ambit and never by a compiler (`src/checker/config.ts`, `src/stubs/*`),
so the two backends receive identical bytes through identical code. Measuring
them per backend would report one number twice.
`test/e2e.config.test.ts` already covers that a config change changes the
diagnostics.

### Gate 4 — performance and memory

`node scripts/m05-backend-compare.ts --corpus <dir> --runs 5`. Both probes do
the same semantic work — walk every project-local file, read every function's
JSDoc tags, and for every call resolve the callee to a symbol, follow an import
alias, take the declaration and classify its source file. Ambit's own
classification is left out of *both* sides, because it is plain JavaScript that
does not vary by backend. Each measurement is its own Node process, and the two
backends are interleaved run by run.

Every reported figure is the median of 5 runs; all five are printed by the
script.

Re-run after adopting 6.0.3, so the legacy column is the shipped version:

| Corpus | Backend | Startup | Extract | Total | Peak RSS (node + child) |
|---|---|---|---|---|---|
| `.m05-corpus`, 301 files / 1,799 calls | legacy 6.0.3 | 411 ms | 39 ms | **450 ms** | 346 + 0 MiB |
| | native 7.0.2 | 55 ms | 104 ms | **159 ms** | 103 + 107 MiB |
| `test/fixtures/realistic-api`, 19 files / 92 calls | legacy 6.0.3 | 118 ms | 26 ms | **145 ms** | 189 + 0 MiB |
| | native 7.0.2 | 21 ms | 18 ms | **39 ms** | 89 + 44 MiB |
| `src`, 35 files / 1,213 calls | legacy 6.0.3 | 426 ms | 110 ms | **535 ms** | 356 + 0 MiB |
| | native 7.0.2 | 54 ms | 103 ms | **154 ms** | 100 + 136 MiB |

All three corpora now produce byte-identical counts on both backends —
301/1500/300/1799/1799/600/300/899, 19/71/64/92/92/31/0/61 and
35/346/4/1213/1212/485/325/402 — which is what makes them comparable at all,
and the script refuses to present a ratio when they do not. `src` was *not*
comparable in the first run of this gate (native resolved 1,143 against
legacy's 1,212); naming `"types": ["node"]` in `tsconfig.json`, which
adopting 6.0.3 required anyway, closed that. `.m05-corpus` names it for the
same reason: without it, gate 4 re-measures gate 2 instead of measuring speed.

**How stable these are.** The table is one quiet-machine session. Re-running
the same command later the same day, on a busier machine and with the Go binary
cold from a fresh install, gave legacy 471 ms and native 201 ms on
`.m05-corpus` — 3% and 28% above the recorded medians. The spread is real and
worth knowing before quoting a ratio to two figures; it does not move any gate,
since the allowances are 10 s and 1 GiB. Note also that the first run of a
freshly installed native engine is an outlier (505 ms total, against a 201 ms
median for that same session): the 23 MB binary has to be paged in.

Native's IPC, from the API's own `getTimingInfo()`: 3,008 requests and 3.3 MiB
received for the 301-file corpus, 173 requests and 1.2 MiB for
`realistic-api`, 1,416 requests and 7.3 MiB for `src`. Transport time was
53 ms of the 159 ms total (33%), 12 ms of 39 ms (30%) and 37 ms of 154 ms
(24%) — under, but not far under, the 50% line §3.5 set for calling transport a
dominant factor.

**Against the allowances set before measuring (DESIGN.md §3.5):**

| Allowance | legacy 6.0.3 | native 7.0.2 |
|---|---|---|
| 30-file first check ≤ 3 s | 145 ms ✓ | 39 ms ✓ |
| 300-file first check ≤ 10 s | 450 ms ✓ | 159 ms ✓ |
| re-query after one file ≤ 500 ms | 214–272 ms ✓ | 1.0–1.9 ms ✓ |
| peak RSS (parent + child) ≤ 1 GiB | 346 MiB ✓ | 210 MiB ✓ |
| transport not the dominant factor | n/a | 24–33% ✓ |

Both pass everything. Native is 2.8×–3.7× faster and uses less total memory,
and none of that speed is required by any allowance — which is the point of
having set them first.

The product-level number is separate and unchanged in kind: `ambit check src`
still costs the same on a re-check as on a first check, because nothing is
cached (§6.2). The 214–272 ms above is the backend half of that; the rest is
Ambit's own analysis and diagnostics.

### Gate 5 — distribution and maintenance

| | legacy (`typescript`, JS implementation) | native (`typescript` 7.0.2, Go) |
|---|---|---|
| Install size | 23 MB (5.9.3), one pure-JS package | 3.5 MB JS + 26 MB platform package (a 23 MB `tsc` binary) |
| Platform packages | none | 20 `optionalDependencies`, pinned to the exact version |
| OS / CPU | wherever Node runs | win32, darwin, linux, aix, freebsd, netbsd, openbsd, sunos across x64/arm64/arm/loong64/mips64el/ppc64/riscv64/s390x. The linux-x64 binary is **statically linked** (verified with `file`), so musl/Alpine needs no separate build |
| Processes | none | one Go child per `API` instance |
| Missing binary | n/a | clear failure: `Unable to resolve @typescript/typescript-darwin-arm64. Either your platform is unsupported, or you are missing the package on disk.` |
| Engine crash mid-session | n/a | opaque: killing the child makes the next call throw `EBADF: bad file descriptor, write`. Ambit would have to translate that into a diagnostic, or an engine death reads as a generic I/O error |
| API stability | stable and public since TS 1.x | all 12 entry points are `unstable/*`; `next` publishes daily dev builds |
| `node_modules/.bin/tsc` | `tsc` | also `tsc` — **they collide** |

The last row was observed, not predicted. Installing 7.0.2 as a devDependency —
even under the alias `typescript-native` — made `pnpm exec tsc --version` report
7.0.2, and the repository's own type check produced the 198 errors in gate 2.
That is DESIGN.md §12 "Separating the build compiler from the analysis
engine" happening in
practice: one `bin` name, two compilers, and the verification command silently
changes meaning. The alias was removed. The comparison compiler now lives in
`.m05-native/` (gitignored), installed by `node scripts/m05-native-install.ts`,
outside this package's dependency tree; `test/architecture.test.ts` asserts that
`src/` cannot reach it and that `dependencies` stays exactly `["typescript"]`.

### The version within the adopted line

The comparison above was framed as "legacy vs native" and took 5.9.3 as given.
It was not given: `git log` shows it entering at the first commit
(`2d98301 chore: project scaffolding`) and never revisited, and the preliminary evaluation
records it as "installed under a comparison alias" — the *representative
of the old API*,
never a considered product choice. One side of a decision about which analyzer
to ship had no recorded reason behind its version number.

`typescript` 6.0.3 (2026-04-16) is a stable release of the same JavaScript
implementation — `bin: { tsc, tsserver }`, no `exports` map, no platform
packages, `engines: node >= 14.17`, the same shape as 5.9.3. It is not the Go
port. npm's `dist-tags` hide this: `beta` still points at `6.0.0-beta` from
February, five months older than 6.0.3, so `npm view typescript dist-tags`
suggests the 6 line never stabilized. `npm view typescript versions` is the
source that shows 6.0.2 and 6.0.3.

The rule was written before measuring, as §3.5's allowances were:

> The analysis engine is the newest stable release of the JS-implementation
> line that leaves `pnpm test`, `tsc --noEmit`, `biome ci`, and
> `check src --coverage` / `check realistic-api --coverage` counts unchanged,
> or changed only by deltas that can be named. If 6.0.3 fails that, the
> specific failure is the reason 5.9.3 stays.

Measured in a `git worktree` with `typescript` set to 6.0.3 and a fresh
install:

| | 5.9.3 | 6.0.3 |
|---|---|---|
| `pnpm test` | 335 pass | 335 pass |
| `tsc --noEmit` | 0 | 0 |
| `check src --coverage` | 29 files, 238 functions, 66.0%, 109 skipped, 1287 call sites | identical, including the `unresolved-by-reason` breakdown |
| `check realistic-api --coverage` | 16 files, 53 functions, 20.8%, 76 call sites | identical |
| gate-4 probe on `src` | 1,213 calls: resolved 1,212, defaultLib 485, external 325, local 402 | identical |
| the same probe, wall clock | 556 / 556 / 567 ms | 560 / 582 / 987 ms (first run cold) |
| peak RSS | 356 MiB | 354 MiB |

The last two rows are the controlled A/B: same worktree, same tsconfigs, only
the compiler swapped, so nothing but the compiler can explain a difference —
and there is none outside run-to-run noise.

**6.0.3 adopted.** The cost is `"types": ["node"]` in `tsconfig.json` and in
the four fixture tsconfigs whose sources use Node builtins (`backend-smoke`,
`cross-module`, `init`, `propagation`). `test/fixtures/realistic-api` already
declared `"types": []` on purpose — it must type-check with nothing installed —
which is why its numbers never moved, and adding the line there breaks it
(verified: TS2688, plus one backend test flipping `ambient-declaration` to
`external-module` because `response.json()` starts resolving to `@types/node`).

What this buys is not speed or resolution — both are unchanged to the count.
It is that the version now has a rule behind it instead of a scaffolding
default, recorded in `AGENTS.md`. Staying would have needed the opposite
sentence ("6.0.3 improves nothing"), which expires the next time the line
releases.

### Decision

**The JavaScript-implementation TypeScript Compiler API is the default for the
initial release, at version 6.0.3.** DESIGN.md §3.5 and ADR-0001
records it, with the reasoning and the conditions that would reopen it. In one
line: adopting the native engine means a second backend on an API published
entirely under `unstable/`, plus owning snapshot invalidation on pain of silent
staleness, and its speed buys no threshold that the JS implementation does not
already meet.

`src/checker/backend/legacy-ts.ts` therefore stops being "a throwaway pending
§3.5" and becomes the adopted backend. Its engine id stays `typescript-legacy`
— it names the JavaScript implementation as against the Go one, and does not
mean unmaintained; diagnostics now report `version: "6.0.3"`. Its file comment, `src/core/backend.ts`'s
`TsBackend` doc, and `AGENTS.md`'s Architecture section were updated to say so
in this change — a file that calls itself disposable after the decision to keep
it is a claim the tree no longer supports.

### The preliminary evaluation (superseded)

This ran before the comparison above, on synthetic code, with no real project
provided. **Every number in it is superseded by the gates above**; it is kept
because it is what the decision rested on until the gates could run, and because
the caveats it records are still the right ones.

| Item | Value |
|---|---|
| Node.js | v24.19.0 |
| Native TypeScript | npm `typescript` 7.0.2 |
| Legacy TypeScript | 5.9.3 (installed under a comparison alias) |
| Oxc | `oxc-parser` 0.148.0 |

On the legacy API, 102 files and 2,009 calls were measured 5 times
sequentially, each in an independent Node process.

| Scope | Median |
|---|---:|
| Compiler import and Program construction | 708.9 ms |
| Type diagnostic retrieval | 125.8 ms |
| Extracting types, signatures, contracts and so on for all calls | 92.6 ms |
| All of the above | 953.5 ms |
| Program update after a contract-comment change and re-query of 9 calls | 21.5 ms |
| Peak RSS of the Node process | 247.7 MiB |

- Fixture generation and Node's own startup are not included in the initial
  measurement. The OS file cache was not cooled.
- Each stage's median is computed independently, so their sum does not match the
  median of the total.
- The measurement after the comment change is a partial re-query, not an
  incremental check including effect propagation and a full diagnostic update.
- The 9 cases cover aliased imports, generics, overloads, callbacks, `any`,
  non-null assertions, unions, Unicode positions, and recursion, and the script's
  assertions succeeded on all 5 runs. That demonstrates neither conformance
  across all language features nor an `unknown` rate.
- The native distribution's type definitions and implementation have entry
  points for types, symbols, call signatures, JSDoc, post-change snapshots, and
  communication measurement. **That is confirmation the API exists, not
  confirmation it works.**
- The Go engine could not obtain `/proc/self/exe` and halted before
  initialization, so the native side was not measured at all here. That was
  environment-specific, as the top of this section records.
- Oxc parsed small TS functions and comments. No type analysis, contract check,
  or speed comparison was carried out with it.

External references consulted for the evaluation are listed in ADR-0001. Do not
equate the TypeScript repository's main branch with the pinned distributed
version's API: the direct API confirmation was done against 7.0.2.

## Milestones

### M0 — specification, diagnostic ledger, RFC procedure, scope

| | |
|---|---|
| Spec section | `ROADMAP.md` M0 |
| Acceptance | review complete |
| Implemented | `docs/DESIGN.md`, `docs/diagnostics/README.md` (18 codes), `AGENTS.md` |
| Evidence | files in tree |
| Outstanding | `rfcs/` and `conformance/` are deferred by §9.1 to 1.0 or the first external adopter, whichever comes first ([ADR-0010](adr/0010-when-governance-takes-effect.md)); `CHANGELOG.md` and §9.2's guaranteed surface hold in the meantime. The npm name `ambit` and the scope `@ambit` are both taken by unrelated owners (ADR-0009); the package is named `ambit-ts` (M4 has the release-readiness of the manifest). |

### M0.5 — backend comparison and adoption gate

| | |
|---|---|
| Spec section | §3.5, ADR-0001 |
| Acceptance | publish §3.5 evidence, adopt a default backend |
| Implemented | **All five gates ran.** Allowances fixed in DESIGN.md §3.5 *before* measuring. Gate 1: `test/backend.conformance.test.ts` (28 tests) against the `TsBackend` interface, plus a native primitive probe. Gate 2: both compilers on the same tsconfigs and the same tree. Gate 3: `scripts/m05-update-correctness.ts`. Gate 4: `scripts/m05-backend-compare.ts` + `scripts/m05-corpus.ts`, 5 interleaved runs per corpus, equal counts enforced. Gate 5: install size, platform coverage, failure modes, `bin` collision. **Default backend decided**: the legacy Compiler API (DESIGN.md §3.5, recorded in `docs/adr/0001-analysis-backend.md`). Before §9.1's trigger, so §9 sends it to `docs/DESIGN.md` and an ADR directly rather than to an RFC |
| Evidence | The "M0.5 — the backend comparison, measured" section above, including "The version within the adopted line" (why `typescript` is 6.0.3 and not the scaffolding default 5.9.3). Every figure was run; the one corpus where the two backends did not do equal work is labelled not comparable rather than turned into a ratio |
| Outstanding | **Linux is not re-verified.** ADR-0001's `/proc/self/exe` failure was environment-specific and the engine runs on darwin/arm64; no Linux run was made in this comparison, so nothing is claimed about it either way. Gate 1's native column checked `getFullyQualifiedName` reconstruction on **one** symbol shape, not on the external-package or project-`.d.ts` shapes. Gates 3 and 4 are worth re-running once §6.2's resident path exists, which is the second of §3.5's three reopening conditions — until then native's 1 ms re-query has nowhere in the product to appear. `conformance/` as a published, external suite (§9.1) still waits for 1.0 or the first external adopter; `test/backend.conformance.test.ts` is its stand-in |

### M1 — effects, unknown, coverage, JSON diagnostics, init, resident path

| | |
|---|---|
| Spec section | §4.2, §4.3, §5.1–5.3, §6.2 |
| Acceptance | dogfooding on Ambit itself; diagnostics update on a contract-comment-only change; schema and measurement conditions fixed |
| Implemented | `@effects` parsing and propagation (rules 1–7 incl. cycles, constructors, `super`, object literals), `unknown`, `--coverage` (with a `declared-by` jsdoc/config split), NDJSON diagnostics with `engine`, a `kind: "authority"` NDJSON record per function (§5.1), `ambit diff <ref>` comparing the working tree's authority against a base ref, carrying symbols across the file renames git reports, and exiting 1 on an increase no approval covers (§6, §6.3), the `ambit.approvals.md` ledger read on both sides of that comparison, `--strict`, `fixes[].edits` for AMB-E001, `ambit init` contract inference. `ambit.config.ts` (§4.1): out-of-code contracts for all five tags, JSDoc-wins merging with `AMB-W005` on a difference, `AMB-W006` for an exact key that matches nothing, user-defined effects usable from both JSDoc and config, per-directory `strict`, and `ambit init --config` for the declarations no comment can carry |
| Evidence | `test/{effects,propagate,summarize,diagnose,construction,cli,fix}.test.ts`; `test/authority-diff.test.ts` (23, the comparison as a pure function including renames, no repository), `test/approvals.test.ts` (19, the ledger grammar and the count-based rule, no repository), `test/diff-output.test.ts` (21, the text and GitHub renderings), `test/e2e.diff.test.ts` (8, against this repository's own history, asserting the worktree is gone after every path), `test/e2e.approvals.test.ts` (9, each case building a repository of its own, for the git rename reading and the ledger on both sides); `check src --coverage` exit 0; `test/backend.legacy-ts.test.ts` self-hosting block; `test/init.test.ts` round-trips every proposal through `check`; `test/e2e.config.test.ts` (15 cases, all through the CLI as a subprocess); `test/e2e.realistic.test.ts` round-trips `init --config`; `test/e2e.install.test.ts` loads a config that imports `ambit-ts/config` from the installed package |
| Outstanding | **The price table is not implemented** — `@budget costUsd` parses, carries and is compared, and nothing prices an LLM call, so it is never enforced (§4.5). Config has no `stubs` key either: a package's effect definitions still come only from `src/stubs/` (§4.2). **No resident or incremental check** (§6.2) — measured above: a re-check costs the same as a first check. **No versioned JSON Schema** for the diagnostic format (§5.2); the shape is fixed in code and documented, not schema-validated. |

### M2 — capabilities, budget, runtime hooks, framework adapters, 50 stubs

| | |
|---|---|
| Spec section | §4.4, §4.5, §4.6 |
| Acceptance | conformance tests for the planned hook targets; contract-to-handler mapping; 50 bundled stub packages |
| Implemented | `@capabilities` narrowing (static, crosses undeclared functions, target globs), the static half of §4.4's dual enforcement for literal HTTP targets (`AMB-E009`), a literal `withAmbit` / `ambitHandler` `spec` read as the handler's own `@capabilities` / `@budget` declaration, with the source-level agreement check kept for a pair that is written twice — the capability set (`AMB-E010`) and the budget (`AMB-E011`), each half judged on its own (`AMB-W004` for a half the source does not fix), `@entrypoint` warning, `@boundary` with mandatory reason and separate coverage accounting, `@budget` parsing/validation, runtime `withAmbit` + `timeMs` enforcement + `runtime.unscoped`, four capability hooks with install/restore — `globalThis.fetch`, `node:fs`/`node:fs/promises`, `node:child_process`, and `pg` (`Pool`/`Client.query`) — every decision recorded on the context's audit trail, `db_read`/`db_write`/`llm` stubs for `pg`/`mysql2`/Prisma/OpenAI/Anthropic, two framework adapters — `ambit-ts/runtime/hono`'s `ambitHandler` and `ambit-ts/runtime/next`'s `ambitRoute`, each registering a route's contract explicitly and establishing the context for the handler and its request decoder |
| Evidence | `test/contracts.test.ts` (41 — the wrapper block compares `withAmbit`, `ambitHandler` and `ambitRoute` registrations against the same handlers' JSDoc), `test/runtime.test.ts` (in-process, 27 — includes the fs, `child_process` and `pg` hooks and their restores), `test/runtime.hono.test.ts` (7 — the adapter driven through Hono itself), `test/runtime.next.test.ts` (10 — the Route Handler called the way Next.js calls it, with a real `NextRequest`; the fetch, `node:fs` and `node:child_process` denials each assert the operation was never reached), `test/e2e.next-app.test.ts` (5 — an `app/**/route.ts` fixture checked end to end and type-checked with nothing installed), `test/e2e.runtime.test.ts` (13 — real socket, real files, a real child process, a real `pg@8` client and a real Hono server, all through the installed package), `test/e2e.install.test.ts` (11 — includes the `ambit-ts/runtime/hono` subpath resolving after `npm install`, `withAmbit` / `ambitHandler` / `ambitRoute` specs read as declarations through the installed package's own specifiers, and README's own `withAmbit`/`ambitHandler`/`ambitRoute` examples plus its `instrumentation.ts` snippet type-checking against the installed package, with `next@16` installed so `NextRequest` resolves for real), `test/e2e.realistic.test.ts` (19 — the six agent-accident scenarios, the `AMB-E009`/`AMB-E005` overlap, and the fixture type-checking with nothing installed), `test/stubs.data-clients.test.ts`, `test/stubs.http-capabilities.test.ts` |
| Outstanding | **`fetch`, `node:fs`, `node:child_process` and `pg` are hooked; nothing else is.** `node:http`/`https`/`net`, `mysql2`/Prisma/Drizzle/MongoDB, OpenAI/Anthropic/Vercel AI — no runtime hook, so calling them is neither blocked nor recorded. The builtin hooks cover named ESM imports only when installed from a preload (`docs/limitations.md`), and the `pg` hook is verified against `pg@8` only. **`costUsd` and `llmCalls` are not enforced**; nothing increments them. **Two framework adapters** — `ambit-ts/runtime/hono` (verified against `hono@4` and `@hono/node-server@1`) and `ambit-ts/runtime/next` (verified against `next@16` on the Node.js runtime, as a Route Handler function: no test starts a `next` server process). Express, BullMQ and `worker_threads` have none, and neither do Next.js Server Actions, `middleware.ts`, the Pages Router, or any route on the Edge runtime — a handler on those establishes no context, so `setUnscopedPolicy` decides what its operations do. **Contract-to-handler mapping is explicit registration** (§4.4's decision): the `spec` passed to `withAmbit`, `ambitHandler` or `ambitRoute` is a value in the module, so it reaches the running handler after a build strips the comments and after a bundler renames everything — the runtime reads no JSDoc, no symbol ID and no file path. A literal `spec` naming a handler in the same file *is* that handler's `@capabilities` / `@budget` (§4.4's "Removing the double declaration"), so the set and the budget are written once; writing the JSDoc tag as well stays legal and a disagreeing pair is still `AMB-E010` / `AMB-E011`. The two cases the `spec` cannot declare — a runtime-built list or budget, and a cross-module handler — still need the JSDoc, and are reported as uncompared (`AMB-W004`). The cross-module case is what §12's "Mapping contracts to handlers" (3) still holds. An adapter covers only the route it wraps: Hono's `app.use` middleware and Next.js's `middleware.ts` both run outside the context (`docs/limitations.md`). **Only HTTP targets are read from source** — no `db:` capability is derived from SQL (§4.4's caveat). **No `@budget` loop-pattern warnings.** Bundled stubs: 52 call entries across 9 namespaces (`fetch`, `globalThis`, `undici`, `node:http`, `node:https`, `node:net`, `node:fs`, `node:fs/promises`, `node:child_process`), 43 constructor entries, 36 pure-builtin methods, 19 in-place-mutation methods, 35 database/LLM client rules across 5 packages (`pg`, `mysql2`, `@prisma/client`, `openai`, `@anthropic-ai/sdk`), and 7 HTTP capability rules — **not** 50 packages. All nine effects now have at least one bundled source. |

### M3 — concrete fix patches, agent protocol

| | |
|---|---|
| Spec section | §5.3, §7 |
| Acceptance | connect one external agent; distinguish analysis failure from contract loosening during iteration |
| Implemented | `fixes[].edits` for AMB-E001: one applicable `widen` patch with `impact`, marked `consistentWithContract: false` |
| Evidence | `test/fix.test.ts` — one test applies the emitted edit mechanically and re-checks clean; a separate test fixes the code *without* touching the contract and re-checks clean |
| Outstanding | **`ambit agent` does not exist** — no NDJSON protocol, no iteration limit, no human-approval gate for loosening fixes, no per-cycle `unknown`-rate tracking. No fix candidates for any diagnostic other than AMB-E001 and `init`'s AMB-I001. No contract-preserving candidate (by design — §5.3 forbids fabricating one). |

### M4 — editor integration, SBOM, npm distribution

| | |
|---|---|
| Spec section | §6, §8 |
| Acceptance | editor compatibility with the chosen compiler; one pilot team |
| Implemented | published to npm as [`ambit-ts`](https://www.npmjs.com/package/ambit-ts) 0.1.0 on 2026-09-10, with a distribution-only build (`tsconfig.build.json` → `dist/`). Tarball distribution works without the registry too: `pnpm pack` → install into a clean project → `npx ambit check` → `npm remove` |
| Evidence | `test/e2e.install.test.ts` (9) — installs into a scratch project, drives the installed bin, type-checks README's own examples against the installed package, uninstalls, and confirms the consumer's own code still type-checks and runs. The published package was then installed from the registry into a scratch project outside this repository and run there: `npm i -D ambit-ts` followed by `npx ambit check src`, on a file whose `pure` declaration is broken two calls away, exits 1 and prints the path (`priceOrder` → `applyTax` → `fetch`). Measured 2026-09-10 against `ambit-ts@0.1.0` — 96 files, 161.5 kB packed, 535.5 kB unpacked, shasum `5914a794ad675453a15b063ef7946923166e3d29` |
| Outstanding | **0.1.0 carries no provenance attestation.** It was published by hand, which is what configuring a trusted publisher requires: that configuration lives on the package's npm settings page, and the page does not exist until a first version has been published. The trusted publisher is configured now — GitHub Actions, `sano-suguru/ambit`, workflow `release.yml`, no environment, `npm publish` allowed — so 0.2.0 onward goes out through `.github/workflows/release.yml` and carries provenance. `v0.1.0` is tagged, and no GitHub release object was created for it: the workflow triggers on `release: published`, and a release for a version already on the registry would fail the publish step. **The workflow has therefore never run.** **No editor integration** — no LSP, no Language Service Plugin, no extension. **`ambit sbom` does not exist**, nor does dependency-effect-diff reporting (§8) or stub trust levels in diagnostics. **No pilot team** — that is an external condition, not a technical one, and cannot be substituted with self-testing. **The runtime ships in the same package as the CLI**, so installing Ambit pulls `typescript` in as a production dependency; §6's runtime split has not been done — §6 defers it until a production adopter exists (ADR-0009). |

### M5 — Phase 1 exit criteria

Out of reach and out of scope for technical work: the Phase 1 exit condition is a
real team showing a measured change in delivery speed and incident rate. No
sample, self-test, or synthetic benchmark substitutes for it. Nothing in this
repository claims progress against it.

## Contract tag support, at a glance

| Tag | Parsed | Statically checked | Runtime-enforced | Audit only |
|---|---|---|---|---|
| `@effects` | yes | yes (§4.2 rules 1–7) | — | — |
| `@capabilities` | yes | yes (caller→callee narrowing; literal HTTP target) | `fetch`, `node:fs`, `node:child_process`, `pg` | every decision recorded on the context |
| `@budget` | yes | validation only | `timeMs` only | — |
| `@entrypoint` | yes | warns without `@capabilities`; compared with a same-file `withAmbit` | establishes the context via `withAmbit` | — |
| `@boundary` | yes | excludes the body; reason required | — | counted in `--coverage` |
| `unknown` | n/a | propagated, reported, counted; `--strict` promotes it | — | — |
