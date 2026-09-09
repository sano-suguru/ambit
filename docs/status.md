# Implementation status against the milestones

Where the code stands against `docs/DESIGN.md` §11's milestones. This file
records *implementation status*, not design — the specification itself is
`docs/DESIGN.md`, and nothing here changes it.

Measured on 2026-09-09, Node.js v24.20.0, macOS (darwin arm64), Apple M1,
8 cores, 16 GiB. Every number below was run, not estimated.

**Verdict: not a release candidate.** M0.5 has not been run at all, M1 has no
config and no incremental path, and M2–M4 are partial. The details are per
row.

## Baseline commands

```sh
pnpm test                     # 242 tests, 18 files — pass
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

| Figure | Value |
|---|---|
| Figure | Before local mutation | After |
|---|---|---|
| files analyzed | 19 | 21 |
| functions extracted | 163 | 176 |
| functions with a declared `@effects` | 4 | 4 |
| `unknown` rate | 68.7% (112/163) | **63.1% (111/176)** |
| `boundary` rate | 0.0% (0/163) | 0.0% (0/176) |
| call sites | 851 — resolved 243, stub 3, known-pure 244, unresolved 361 | 924 — resolved 268, stub 3, known-pure 244, mutation 81, unresolved 328 |
| unresolved by reason | `builtin-method` 131, `external-module` 221, `unresolved-symbol` 8, `callback-parameter` 1 | `builtin-method` 62, `external-module` 257, `unresolved-symbol` 8, `callback-parameter` 1 |
| skipped function-like nodes | 74 (`callback-argument` 66, `nested-function` 8) | 75 (`callback-argument` 67, `nested-function` 8) |
| exit code | 0 | 0 |

The "after" column is DESIGN.md §4.2's local-mutation rule (「ローカル変異と
`pure`」) in place. `builtin-method` unresolved dropped 131 → 62: 81 sites
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

The remaining 63% unknown rate is dominated by `external-module` (257), which is almost
entirely calls into the `typescript` compiler API from the connection layer —
the one file that is meant to be replaceable. It is a real number, not a
target that has been met: DESIGN.md §10's goal is 30% for an *adopting team*
after three months, which no one has done.

It had gone **up** from 63.2% (86/136) before local mutation was decided —
measured before the client stubs and the capability work — because the
denominator grew by 27 functions whose helpers use `Array.push` and `Map.set`,
which the pure-builtin allowlist deliberately excludes. That is what §4.2's
decision addressed; the figure is now at 63.1%, marginally below the 63.2% it started from.

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
client, an LLM SDK, a barrel file, pure domain logic). **This is not a team**,
and it does not satisfy §10, which requires a real adopting team after three
months. It is the fixture that makes the number measurable at all.

| Figure | Before the client stubs | After |
|---|---|---|
| files analyzed | 9 | 9 |
| functions extracted | 19 | 19 |
| `unknown` rate | 47.4% (9/19) | **10.5% (2/19)** |
| `boundary` rate | 0.0% | 0.0% |
| call sites | 31 — resolved 12, stub 1, pure 9, unresolved 9 | 31 — resolved 12, stub 8, pure 9, mutation 1, unresolved 1 |
| unresolved by reason | `builtin-method` 1, `unresolved-symbol` 8 | `ambient-declaration` 1 |
| top unresolved names | `Map.set` 1 | (none) |
| exit code | 0 | 0 |

The "After" column now also carries DESIGN.md §4.2's local-mutation rule. It
moved the fixture's `unknown` rate from 10.5% (2/19) to **5.3% (1/19)**:
`putRate` in `src/lib/cache.ts` writes into a module-scope `Map`, which is
now inferred as `state_write` instead of leaving the function `unknown`. It
declares no `@effects` at all, so nothing is diagnosed — an undeclared
function is a coverage concern, not a violation (§4.3) — but its effects are
now known rather than unknown.

The one remaining `unknown` is accounted for:

- one `ambient-declaration` — `(await fetch(url)).json()`. The method is
  declared on a type from a `.d.ts`, and the pure-builtin allowlist covers only
  the compiler's own lib, so the call cannot be named.

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

The re-check costs the same as the first check because **nothing is cached**.
DESIGN.md §6.2's resident/incremental path is not implemented, so "初回検査"
and "変更後の再検査" are the same operation. That is the honest reading of
these numbers, and the reason no threshold has been set: there is nothing yet
to compare against.

The table above is the original measurement and has **not** been superseded.
Re-running the same command while adding the client stubs gave 1.72–3.20 s, and
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
| Implemented | `@effects` parsing and propagation (rules 1–7 incl. cycles, constructors, `super`, object literals), `unknown`, `--coverage`, NDJSON diagnostics with `engine`, `--strict`, `fixes[].edits` for AMB-E001, `ambit init` contract inference |
| Evidence | `test/{effects,propagate,summarize,diagnose,construction,cli,fix}.test.ts`; `check src --coverage` exit 0; `test/backend.legacy-ts.test.ts` self-hosting block; `test/init.test.ts` round-trips every proposal through `check` |
| Outstanding | **`ambit init` writes no config** — it proposes JSDoc (§4.1's inference half) but `ambit.config.ts` is not implemented, so out-of-code contracts, user-defined effects, per-directory `strict`, and the price table have nowhere to live. **No resident or incremental check** (§6.2) — measured above: a re-check costs the same as a first check. **No versioned JSON Schema** for the diagnostic format (§5.2); the shape is fixed in code and documented, not schema-validated. |

### M2 — capabilities, budget, runtime hooks, framework adapters, 50 stubs

| | |
|---|---|
| Spec section | §4.4, §4.5, §4.6 |
| Acceptance | conformance tests for the planned hook targets; contract-to-handler mapping; 50 bundled stub packages |
| Implemented | `@capabilities` narrowing (static, crosses undeclared functions, target globs), the static half of §4.4's 二重強制 for literal HTTP targets (`AMB-E009`), source-level `withAmbit` ↔ `@entrypoint` agreement (`AMB-E010`/`AMB-W004`), `@entrypoint` warning, `@boundary` with mandatory reason and separate coverage accounting, `@budget` parsing/validation, runtime `withAmbit` + `globalThis.fetch` blocking + `timeMs` enforcement + `runtime.unscoped`, `db_read`/`db_write`/`llm` stubs for `pg`/`mysql2`/Prisma/OpenAI/Anthropic |
| Evidence | `test/contracts.test.ts` (26), `test/runtime.test.ts` (mock-level, 13), `test/e2e.runtime.test.ts` (real socket, through the installed package, 4), `test/e2e.realistic.test.ts` (15 — all six agent-accident scenarios), `test/stubs.data-clients.test.ts`, `test/stubs.http-capabilities.test.ts` |
| Outstanding | **Only `fetch` is hooked at runtime.** `node:fs`, `node:http`/`https`/`net`, `child_process`, `pg`/`mysql2`/Prisma/Drizzle/MongoDB, OpenAI/Anthropic/Vercel AI — none. **`costUsd` and `llmCalls` are not enforced**; nothing increments them. **No framework adapters** (Express/Hono/Next.js/BullMQ). **Contract-to-handler mapping is source-level only** — a literal capability array is compared with the JSDoc of a handler declared in the same file; a list built at runtime, a handler from another module, or a build/bundle that moves either half is reported as uncompared (`AMB-W004`), and §12's 「契約とハンドラの対応付け」 stays open. **Only HTTP targets are read from source** — no `db:` capability is derived from SQL (§4.4's caveat). **No `@budget` loop-pattern warnings.** Bundled stubs: 52 call entries across 9 namespaces (`fetch`, `globalThis`, `undici`, `node:http`, `node:https`, `node:net`, `node:fs`, `node:fs/promises`, `node:child_process`), 43 constructor entries, 29 pure-builtin methods, 19 in-place-mutation methods, 35 database/LLM client rules across 5 packages (`pg`, `mysql2`, `@prisma/client`, `openai`, `@anthropic-ai/sdk`), and 7 HTTP capability rules — **not** 50 packages. All nine effects now have at least one bundled source. |

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
| Evidence | `test/e2e.install.test.ts` (6) — installs into a scratch project, drives the installed bin, uninstalls, and confirms the consumer's own code still type-checks and runs |
| Outstanding | **Not published to npm** (requires approval; the `@ambit` scope is unsecured and the package is `private: true`). **No editor integration** — no LSP, no Language Service Plugin, no extension. **`ambit sbom` does not exist**, nor does dependency-effect-diff reporting (§8) or stub trust levels in diagnostics. **No pilot team** — that is an external condition, not a technical one, and cannot be substituted with self-testing. |

### M5 — Phase 1 exit criteria

Out of reach and out of scope for technical work: §10's exit condition is a
real team showing a measured change in delivery speed and incident rate. No
sample, self-test, or synthetic benchmark substitutes for it. Nothing in this
repository claims progress against it.

## Contract tag support, at a glance

| Tag | Parsed | Statically checked | Runtime-enforced | Audit only |
|---|---|---|---|---|
| `@effects` | yes | yes (§4.2 rules 1–7) | — | — |
| `@capabilities` | yes | yes (caller→callee narrowing; literal HTTP target) | `fetch` only | recorded on the context |
| `@budget` | yes | validation only | `timeMs` only | — |
| `@entrypoint` | yes | warns without `@capabilities`; compared with a same-file `withAmbit` | establishes the context via `withAmbit` | — |
| `@boundary` | yes | excludes the body; reason required | — | counted in `--coverage` |
| `unknown` | n/a | propagated, reported, counted; `--strict` promotes it | — | — |
