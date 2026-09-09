# Implementation status against the milestones

Where the code stands against `docs/DESIGN.md` §11's milestones. This file
records *implementation status*, not design — the specification itself is
`docs/DESIGN.md`, and nothing here changes it.

Measured on 2026-09-09, Node.js v24.20.0, macOS (darwin arm64), Apple M1,
8 cores, 16 GiB. Every number below was run, not estimated.

**Verdict: not a release candidate.** M0.5 has not been run at all, M1 has no
incremental path, and M2–M4 are partial. The details are per row.

## Baseline commands

```sh
pnpm test                     # 305 tests, 20 files — pass
pnpm exec tsc --noEmit        # pass
./node_modules/.bin/biome ci .  # pass
node src/cli/main.ts check src --coverage   # exit 0
node src/cli/main.ts check test/fixtures/realistic-api --coverage   # exit 0
```

`pnpm exec biome ci .` returns 1 in one local shell because of a
user-installed command wrapper, not because of this repository —
`pnpm exec biome --version` fails the same way. Run the binary directly
(`./node_modules/.bin/biome ci .`) to see the real exit code, which is 0. CI
runs `pnpm exec biome ci .` in GitHub Actions, where no such wrapper exists.

## Ambit's own source (`check src --coverage`)

| Figure | After the runtime hooks | After the Hono adapter | Before `ambit.config.ts` | After `ambit.config.ts` |
|---|---|---|---|---|
| files analyzed | 26 | 27 | 27 | 29 |
| functions extracted | 193 | 194 | 202 | 236 |
| functions with a declared `@effects` | 4 | 4 | 4 | 4 (jsdoc 4, config 0) |
| `unknown` rate | 64.2% (124/193) | 64.4% (125/194) | 63.4% (128/202) | **65.7% (155/236)** |
| `boundary` rate | 0.0% (0/193) | 0.0% (0/194) | 0.0% (0/202) | 0.0% (0/236) |
| call sites | 997 — resolved 298, stub 3, known-pure 257, mutation 94, unresolved 345 | 1003 — resolved 299, stub 3, known-pure 258, mutation 94, unresolved 349 | 1035 — resolved 315, stub 3, known-pure 260, mutation 93, unresolved 364 | 1278 — resolved 404, stub 8, known-pure 327, mutation 110, unresolved 429 |
| unresolved by reason | `builtin-method` 68, `external-module` 264, `unresolved-symbol` 11, `callback-parameter` 2 | `builtin-method` 68, `external-module` 265, `unresolved-symbol` 12, `callback-parameter` 4 | `builtin-method` 72, `external-module` 276, `unresolved-symbol` 12, `callback-parameter` 4 | `builtin-method` 102, `external-module` 307, `dynamic-import` 1, `unresolved-symbol` 15, `callback-parameter` 4 |
| skipped function-like nodes | 88 (`callback-argument` 74, `nested-function` 14) | 90 (`callback-argument` 75, `nested-function` 15) | 91 (`callback-argument` 76, `nested-function` 15) | 109 (`callback-argument` 91, `object-literal-method` 3, `nested-function` 15) |
| exit code | 0 | 0 | 0 | 0 |

The two earliest columns (before and after DESIGN.md §4.2's local-mutation
rule: 19/163 and 21/176) are dropped from the table to keep it readable; the
paragraphs below still describe that change, and its numbers are in the git
history of this file.

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
local-mutation rule (「ローカル変異と `pure`」) before and after. `builtin-method` unresolved dropped 131 → 62: 81 sites
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
target that has been met: DESIGN.md §10's goal is 30% for an *adopting team*
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

DESIGN.md §10's `unknown`-rate target is about a team's own code, not about
Ambit's connection layer, so it is measured against
`test/fixtures/realistic-api` — a Node backend of the shape a coding agent
produces (HTTP handlers with `@entrypoint` contracts, a `pg` pool, a Prisma
client, a `mysql2` pool, two LLM SDKs, a barrel file, pure domain logic). **This is not a team**,
and it does not satisfy §10, which requires a real adopting team after three
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

The re-check costs the same as the first check because **nothing is cached**.
DESIGN.md §6.2's resident/incremental path is not implemented, so "初回検査"
and "変更後の再検査" are the same operation. That is the honest reading of
these numbers, and the reason no threshold has been set: there is nothing yet
to compare against.

Every row is labelled with the tree it was measured on. The last row is the
current tree; the rows above it are smaller trees and are kept as recorded,
not restated for this build.

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

## Milestones

### M0 — specification, diagnostic ledger, RFC procedure, scope

| | |
|---|---|
| Spec section | §11 M0 |
| Acceptance | review complete |
| Implemented | `docs/DESIGN.md`, `docs/diagnostics/README.md` (15 codes), `AGENTS.md` |
| Evidence | files in tree |
| Outstanding | `rfcs/` and `conformance/` are deferred to first publish by §9. The npm scope `@ambit` is **not** secured; the package is named `ambit` and is `private: true`. |

### M0.5 — backend comparison and adoption gate

| | |
|---|---|
| Spec section | §3.5, Appendix A |
| Acceptance | publish §3.5 evidence, adopt a default backend by RFC |
| Implemented | nothing beyond Appendix A's preliminary probe |
| Evidence | none — Appendix A explicitly records the native engine failing to start |
| Outstanding | **All five gates.** No API-conformance suite, no TS 5.x compatibility comparison, no update-correctness matrix, no performance or memory comparison, no distribution/maintenance assessment. `src/checker/backend/legacy-ts.ts` remains a disposable connection layer, not an adopted product backend. No performance number is assigned to any unrun backend. |

### M1 — effects, unknown, coverage, JSON diagnostics, init, resident path

| | |
|---|---|
| Spec section | §4.2, §4.3, §5.1–5.3, §6.2 |
| Acceptance | dogfooding on Ambit itself; diagnostics update on a contract-comment-only change; schema and measurement conditions fixed |
| Implemented | `@effects` parsing and propagation (rules 1–7 incl. cycles, constructors, `super`, object literals), `unknown`, `--coverage` (with a `declared-by` jsdoc/config split), NDJSON diagnostics with `engine`, `--strict`, `fixes[].edits` for AMB-E001, `ambit init` contract inference. `ambit.config.ts` (§4.1): out-of-code contracts for all five tags, JSDoc-wins merging with `AMB-W005` on a difference, `AMB-W006` for an exact key that matches nothing, user-defined effects usable from both JSDoc and config, per-directory `strict`, and `ambit init --config` for the declarations no comment can carry |
| Evidence | `test/{effects,propagate,summarize,diagnose,construction,cli,fix}.test.ts`; `check src --coverage` exit 0; `test/backend.legacy-ts.test.ts` self-hosting block; `test/init.test.ts` round-trips every proposal through `check`; `test/e2e.config.test.ts` (15 cases, all through the CLI as a subprocess); `test/e2e.realistic.test.ts` round-trips `init --config`; `test/e2e.install.test.ts` loads a config that imports `ambit/config` from the installed package |
| Outstanding | **The price table is not implemented** — `@budget costUsd` parses, carries and is compared, and nothing prices an LLM call, so it is never enforced (§4.5). Config has no `stubs` key either: a package's effect definitions still come only from `src/stubs/` (§4.2). **No resident or incremental check** (§6.2) — measured above: a re-check costs the same as a first check. **No versioned JSON Schema** for the diagnostic format (§5.2); the shape is fixed in code and documented, not schema-validated. |

### M2 — capabilities, budget, runtime hooks, framework adapters, 50 stubs

| | |
|---|---|
| Spec section | §4.4, §4.5, §4.6 |
| Acceptance | conformance tests for the planned hook targets; contract-to-handler mapping; 50 bundled stub packages |
| Implemented | `@capabilities` narrowing (static, crosses undeclared functions, target globs), the static half of §4.4's 二重強制 for literal HTTP targets (`AMB-E009`), source-level `withAmbit` ↔ `@entrypoint` agreement on both the capability set (`AMB-E010`) and the budget (`AMB-E011`), each half judged on its own (`AMB-W004` for a half the source does not fix), `@entrypoint` warning, `@boundary` with mandatory reason and separate coverage accounting, `@budget` parsing/validation, runtime `withAmbit` + `timeMs` enforcement + `runtime.unscoped`, four capability hooks with install/restore — `globalThis.fetch`, `node:fs`/`node:fs/promises`, `node:child_process`, and `pg` (`Pool`/`Client.query`) — every decision recorded on the context's audit trail, `db_read`/`db_write`/`llm` stubs for `pg`/`mysql2`/Prisma/OpenAI/Anthropic, one framework adapter (`ambit/runtime/hono`'s `ambitHandler`, which registers a route's contract explicitly and establishes the context for the handler and its request decoder) |
| Evidence | `test/contracts.test.ts` (30 — the last four compare a `withAmbit` and an `ambitHandler` registration against the same handler's JSDoc), `test/runtime.test.ts` (in-process, 27 — includes the fs, `child_process` and `pg` hooks and their restores), `test/runtime.hono.test.ts` (7 — the adapter driven through Hono itself), `test/e2e.runtime.test.ts` (13 — real socket, real files, a real child process, a real `pg@8` client and a real Hono server, all through the installed package), `test/e2e.install.test.ts` (9 — includes the `ambit/runtime/hono` subpath resolving after `npm install`, and README's own `withAmbit`/`ambitHandler` examples type-checking against the installed package), `test/e2e.realistic.test.ts` (17 — the six agent-accident scenarios, the `AMB-E009`/`AMB-E005` overlap, and the fixture type-checking with nothing installed), `test/stubs.data-clients.test.ts`, `test/stubs.http-capabilities.test.ts` |
| Outstanding | **`fetch`, `node:fs`, `node:child_process` and `pg` are hooked; nothing else is.** `node:http`/`https`/`net`, `mysql2`/Prisma/Drizzle/MongoDB, OpenAI/Anthropic/Vercel AI — no runtime hook, so calling them is neither blocked nor recorded. The builtin hooks cover named ESM imports only when installed from a preload (`docs/limitations.md`), and the `pg` hook is verified against `pg@8` only. **`costUsd` and `llmCalls` are not enforced**; nothing increments them. **One framework adapter** — `ambit/runtime/hono` (verified against `hono@4` and `@hono/node-server@1`); Express, Next.js and BullMQ have none, and a route they register establishes no context, so `setUnscopedPolicy` decides what its operations do. **Contract-to-handler mapping is explicit registration** (§4.4's decision): the `spec` passed to `withAmbit` or `ambitHandler` is a value in the module, so it reaches the running handler after a build strips the comments and after a bundler renames everything — the runtime reads no JSDoc, no symbol ID and no file path. The cost is that the capability set and the budget are written twice, and the check on the pair is source-level: a literal array and a literal `budget` object compared with the JSDoc of a handler declared in the same file, with a runtime-built list, a runtime-built budget or a cross-module handler reported as uncompared (`AMB-W004`). Removing the duplication needs a build-time transform (§4.5's Phase 1 非目標), which is what §12's 「契約とハンドラの対応付け」 still holds. The adapter covers only the route it wraps: `app.use` middleware runs outside the context (`docs/limitations.md`). **Only HTTP targets are read from source** — no `db:` capability is derived from SQL (§4.4's caveat). **No `@budget` loop-pattern warnings.** Bundled stubs: 52 call entries across 9 namespaces (`fetch`, `globalThis`, `undici`, `node:http`, `node:https`, `node:net`, `node:fs`, `node:fs/promises`, `node:child_process`), 43 constructor entries, 36 pure-builtin methods, 19 in-place-mutation methods, 35 database/LLM client rules across 5 packages (`pg`, `mysql2`, `@prisma/client`, `openai`, `@anthropic-ai/sdk`), and 7 HTTP capability rules — **not** 50 packages. All nine effects now have at least one bundled source. |

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
| Implemented | tarball distribution: `pnpm pack` → install into a clean project → `npx ambit check` → `npm remove`, with a distribution-only build (`tsconfig.build.json` → `dist/`) |
| Evidence | `test/e2e.install.test.ts` (9) — installs into a scratch project, drives the installed bin, type-checks README's own examples against the installed package, uninstalls, and confirms the consumer's own code still type-checks and runs |
| Outstanding | **Not published to npm** (requires approval; the `@ambit` scope is unsecured and the package is `private: true`). **No editor integration** — no LSP, no Language Service Plugin, no extension. **`ambit sbom` does not exist**, nor does dependency-effect-diff reporting (§8) or stub trust levels in diagnostics. **No pilot team** — that is an external condition, not a technical one, and cannot be substituted with self-testing. **The runtime ships in the same package as the CLI**, so installing Ambit pulls `typescript` in as a production dependency; §6.1's `@ambit/runtime` split has not been done. |

### M5 — Phase 1 exit criteria

Out of reach and out of scope for technical work: §10's exit condition is a
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
