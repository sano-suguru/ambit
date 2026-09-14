# Current status

Node.js v24.20.0, macOS (darwin arm64), Apple M1, 8 cores, 16 GiB. Every number
here was run, not estimated — but not all on the same day. Re-run **2026-09-14**:
`pnpm test`, `tsc --noEmit`, `biome ci`, `check src --coverage`, `check src
--strict`, `check test/fixtures/realistic-api --coverage`, `npm pack --dry-run`,
and the `check src` / `diff HEAD src` latency. Quoted from the runs archived in
[`docs/measurements/`](measurements/), not re-taken: the corpus median and the
npm install evidence.

This file records *implementation status*, not design. The specification is
[`docs/DESIGN.md`](DESIGN.md). How the third-party and resident numbers were
reached — the runs, the misses found on the way and the re-measurements — is in
[`docs/measurements/`](measurements/), linked from those claims below.

## Verdict

**0.2.0 is published and not production-proven.** All five M0.5 backend gates
ran and the default backend is decided ([ADR-0001](adr/0001-analysis-backend.md)).
M1's incremental path exists, is benchmarked, and is not exposed: there is no CLI flag. M2–M4 are partial. M5 — the Phase 1 exit criterion —
is untouched, and cannot be moved by technical work.

What 0.2.0 asserts is `docs/DESIGN.md` §9.2's guaranteed surface under semver's
0.x rule: a breaking change to it may land in a minor release (§9.3) and is
announced in `CHANGELOG.md`. That is not the stability a 1.0 would claim.

## Key metrics

| Metric | Current | Target |
|---|---:|---:|
| **External pilot evidence** | **not yet collected** | the Phase 1 evidence in `ROADMAP.md` |
| Reviewer actions an Ambit report caused on an external team's pull requests | not yet collected | > 0 |
| `unknown` rate, real third-party code (corpus median, 4,200 functions) | 52.9% | lower — no target (see below) |
| `unknown` rate, adopting-team-equivalent fixture (`realistic-api`) | 7.1% (4/56) | no target (see below) |
| `unknown` rate, Ambit's own source (`check src`) | 40.0% (169/422) | — |
| `check src --strict` on Ambit's own source | exit 1: 23 unresolved-call warnings promoted to errors | — |
| Authority Ambit sees in a third-party backend's data layer ([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)) | 940 stubbed call sites, up from 120 | — |
| Third-party backends `ambit diff` is silent on when nothing changed | **3** — Unleash ([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)), immich ([2026-09-11](measurements/2026-09-11-second-third-party-validation-immich.md)), outline ([2026-09-11](measurements/2026-09-11-third-third-party-validation-outline.md)) | — |
| `unknown` rate, second third-party backend (immich `server/src`, 3,191 functions) | 79.9% (2,550/3,191) | no target (see below) |
| `unknown` rate, third third-party backend (outline `server`, 2,245 functions) | 72.8% (1,635/2,245) | no target (see below) |
| Tests | 829 passing, 40 files | green |
| `tsc --noEmit` / `biome ci .` | pass / pass | pass |
| `check src` latency, 43 files | 1.31–1.75 s, five runs (`diff HEAD src`: 2.18–2.95 s) | §3.5's 3 s allowance |
| Incremental / resident analysis | a resident session, benchmarked against `analyze()` on six subjects ([2026-09-13](measurements/2026-09-13-resident-benchmark.md)); faster for edits with a small importer closure; a contract-only JSDoc edit measured 4.9×–5.8× faster than cold on the two large high-fan-out subjects ([2026-09-13](measurements/2026-09-13-resident-jsdoc-narrowing.md)); no CLI exposure | yes (§6.2), exposed and measured |
| Bundled stub packages | 6 DB/LLM clients, 9 builtin namespaces | 50 packages |
| Runtime hooks | 4 (`fetch`, `node:fs`, `node:child_process`, `pg`) | — |
| Framework adapters | 2 (Hono, Next.js App Router) | — |

**None of the five `unknown` rows has a target, and that is deliberate.**
`ROADMAP.md` tracks **an adopting team's own code, with its own
`node_modules`,** relative to that team's first run. No row here is that
population: the corpus is five repositories measured with no dependencies
installed, `realistic-api` is a fixture written in this repository, `src` is
Ambit's own connection layer, and immich and outline are third-party backends
nobody here has adopted. They are read as movement, not as Phase 1 evidence.

On the three third-party backends, **the `unknown` rate and the usefulness of
`diff` moved independently.** The subject with the lowest rate at the time,
outline, was the one with the only silent miss, and closing hundreds of call
sites moved the rate not at all. What the gate was worth tracked standing noise
on an unchanged tree, the precision of the delta, and whether a real increase
was reported at all. That is an observation from three subjects, not a finding
about adopters.

### Baseline commands

```sh
pnpm test                                                    # 829 tests, 40 files — pass
pnpm exec tsc --noEmit                                       # pass
./node_modules/.bin/biome ci .                               # pass
node src/cli/main.ts check src --coverage                    # exit 0
node src/cli/main.ts check test/fixtures/realistic-api --coverage   # exit 0
node src/cli/main.ts check test/fixtures/next-app --coverage        # exit 0
node src/cli/main.ts diff HEAD src                           # exit 0, ledger's approvals in place
node scripts/bench-corpus.ts                                 # median 52.9%
npm pack --dry-run                                           # 104 files, 243.4 kB packed
```

`pnpm exec biome ci .` returns 1 in one local shell because of a user-installed
command wrapper, not because of this repository. Run the binary directly to see
the real exit code; CI runs `pnpm exec biome ci .`, where no such wrapper exists.

## What is proven

Each of these was measured, and the run is archived.

- **Effect propagation works on code nobody here wrote.** The fixed corpus in
  `test/corpus/corpus.json` — five server-side TypeScript projects (`hono`,
  `trpc-server`, `elysia`, `got`, `drizzle-orm`), pinned by commit SHA and by
  the git tree object of each measured subtree — went from a 76.7% median
  `unknown` rate to 52.9%. The steps are in
  [2026-09-11](measurements/2026-09-11-coverage-and-latency.md); the current
  median is [2026-09-12](measurements/2026-09-12-optional-callback-opacity.md)'s.
- **`ambit diff` gives reviewable signal on a backend nobody here wrote.** On
  Unleash (`Unleash/unleash@044461b`, `src/lib`, dependencies installed) the
  untouched tree reports **no** increase. An added `fetch`, `node:fs` or
  `node:child_process` call (with or without the `node:` prefix) is reported
  with the whole call path to the controller, and an added `ky` call and a knex
  `del()` inside an existing read method each exit **1**;
  the repository's stubbed call sites are 953.
  [2026-09-11](measurements/2026-09-11-third-party-diff-validation.md).
- **The same holds on a pnpm-workspace monorepo.** On immich
  (`immich-app/immich@2a62622`, NestJS, kysely, `server/src`) an unmodified tree
  reports **no increase, exit 0 in both modes**; `fetch`, `node:fs` /
  `node:child_process` and their un-prefixed spellings are each reported with
  the whole call path through two NestJS indirections to the controller; and
  `HEAD~20` over 443 changed files reports no authority increase and 35
  unresolvable gains (`--strict` exits 1 on those). `diff` gets there by linking
  `node_modules` from every directory between the repository root and the
  checked one, which it does itself.
  [2026-09-11](measurements/2026-09-11-second-third-party-validation-immich.md).
- **A third backend repeated those properties.** On outline
  (`outline/outline@35dd15b9`, Koa with inline route handlers, Sequelize): zero
  standing noise in both modes; `fetch`, `node:fs` / `node:child_process` and
  their un-prefixed spellings reported with the whole call path;
  history diffs proportional to the change. One finding is open: a §6.4 entry
  reads `? <unnamed>` when the receiver is a project class inheriting the method
  from a package — an ActiveRecord ORM's whole surface.
  [2026-09-11](measurements/2026-09-11-third-third-party-validation-outline.md).
- **A route registered as an inline handler is not invisible.** Authority added
  inside one fails the gate, reported against `file.ts#<inline callbacks>`. On
  all three subjects the unmodified tree still reports **zero** increases at
  exit 0 in both modes. What this does not give is per-handler identity (see
  What is not proven).
  [2026-09-11](measurements/2026-09-11-inline-callback-owner.md),
  [ADR-0013](adr/0013-the-inline-callback-owner.md).
- **The gate is real and it has cost something.** `ambit diff HEAD~1 src` runs
  as a **gating** CI step here. The change that introduced the approval ledger
  was itself a legitimate authority increase: `diff HEAD src` exited 1 with no
  ledger and 0 with five approval lines.
- **The package installs and runs from the registry.** `ambit-ts@0.2.0`
  (npm `latest`) was installed with `npm i -D ambit-ts` into a scratch
  TypeScript 5 project outside this repository, and the Quick start in the
  README shipped with 0.2.0 ran as written: `check` exits 1 on an added `fetch`, `diff HEAD` exits 1 on the
  widened contract, and an `ambit.approvals.md` line takes it to 0. README's
  pull-request workflow was reproduced on a local merge checkout — exit 2 at
  `fetch-depth` 1, exit 1 at 2 with no approval, 0 with one.
- **0.1.0 has a known false negative; 0.2.0 fixes it.** On a tsconfig with no
  `types`, 0.1.0 loaded no `@types/*`, so a `pure` function gaining
  `writeFileSync` passed both `check` and `diff`. 0.2.0 reports `AMB-E001`, on
  the registry artifact as well as in `test/stubs.node-builtins.test.ts`.
- **Releases carry provenance.** 0.2.0 went out through
  `.github/workflows/release.yml`, and its SLSA provenance attestation verifies
  with `npm audit signatures`.
- **Runtime enforcement blocks real operations.** `test/e2e.runtime.test.ts`
  drives a real socket, real files, a real child process, a real `pg@8` client
  and a real Hono server through the installed package; the Next.js denials each
  assert the operation was never reached.
- **The backend is replaceable in the way §3.4 claims.**
  `test/backend.conformance.test.ts` asserts against the `TsBackend` interface
  rather than against a compiler, and `test/architecture.test.ts` enforces that
  only `legacy-ts.ts` imports `typescript`.

## What is not proven

- **External pilot validation.** Evidence from production-bound pull requests
  has not yet been collected. This is the most important row above, and no
  amount of test coverage substitutes for it.
- **That a file-level report on an inline handler is reviewable enough.** An
  increase inside an argument-position handler names the file, not the handler,
  and authority moving *between* two such handlers is reported as "the bodies
  cannot be matched" rather than as an increase. No adopter has said whether
  that is enough ([`docs/open-questions.md`](open-questions.md)).
- **That `ambit diff --strict` is usable on a repository with inline test
  callbacks.** One added line in a test file takes `--strict` from exit 0 to
  exit 1 on all three third-party subjects. Default `ambit diff` is unaffected.
- **That the corpus number generalizes.** The corpus does not install its
  dependencies, so 52.9% is not what an adopting team with a populated
  `node_modules` would see, in either direction.
- **Linux.** The M0.5 comparison ran on darwin/arm64 only. Nothing is claimed
  about Linux either way.
- **Performance under load.** The latency figures were taken on a machine that
  was not quiescent for all of them, and §3.5's performance gate has not been
  re-run. The runtime overhead of a context and a `decode` is unmeasured, as is
  the cost of going through a replaced function.
- **README's CI workflow on GitHub itself.** It was reproduced with local git
  merge checkouts, not run by GitHub Actions on an adopter's repository. 0.1.0
  was published by hand and carries no provenance attestation.

## Current bottleneck

**External pilot evidence.**

The inline-route-handler silence is closed
([ADR-0013](adr/0013-the-inline-callback-owner.md)). It leaves two questions
only a user can answer — whether a file-level increase is reviewable, and
whether `--strict` is usable with inline test callbacks — both under What is
not proven.

`unknown` on real third-party code is the main technical risk to watch during a
pilot, not a gate in front of one. At a 52.9% corpus median, more than half of
all functions still depend on a path the analysis did not reach. The largest
contributor is `external-module`: calls into packages whose types are not
installed. On Ambit's own source the figure is dominated by calls into the
`typescript` compiler API from the connection layer, the one file §3.4 means to
be replaceable.

Which unresolved names *matter* is a question only a pilot can answer; on real
code with dependencies installed, the histogram at least names them. On Unleash the histogram names `knex.QueryBuilder.where` (448 sites, the
top name), `express.Response.*` and `supertest.Test.*`. There, `unknown` and the
gate were less coupled than the rate suggests: a *known* effect added inside an
`unknown` symbol already fails the comparison. A gain the analysis cannot
resolve is reported under §6.4 ([ADR-0012](adr/0012-reporting-an-unresolvable-gain.md))
and fails only under `diff --strict`; measured on the same backend, 3 symbols
over `HEAD~20..HEAD`, silent on the untouched tree
([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)). For a
package no bundled table covers, `--strict` has no exit short of `@boundary`
([`docs/limitations.md`](limitations.md)).

## The resident check path (§6.2)

Phases 0–5 of [`docs/resident-check-path.md`](resident-check-path.md) are built;
phase 6, CLI exposure, is not. Every resident answer compared with a cold `analyze()`
was byte-equal to it. Apple M1, one machine, not re-run on Linux.

- **Faster only where the reverse-import closure is small.** A leaf or
  `ambit.config.ts` edit: 1,947 → 331 ms on drizzle-orm (448 files), 10,361 →
  2,200 ms on immich `server/src` (557 files). An edit to the most widely
  imported file — a deliberately worst-case-leaning row — and a file addition or
  tsconfig edit cost about what `analyze()` costs — against cold, immich +2–6%,
  outline +12–24%, drizzle-orm −8–10%.
  [2026-09-13](measurements/2026-09-13-resident-benchmark.md),
  [2026-09-14](measurements/2026-09-14-resident-large-workload.md).
- **A contract-only JSDoc edit re-extracts the edited file alone**: 432/448 → 1/448
  files on drizzle-orm, 419/557 → 1/557 on immich. A non-contract JSDoc edit
  still pays the closure.
  [ADR-0015](adr/0015-contract-only-jsdoc-edits.md),
  [2026-09-13](measurements/2026-09-13-resident-jsdoc-narrowing.md).
- **What is left is the compiler.** `createProgram` + `getTypeChecker` is
  79–95% of a small update on the large subjects. Resident peak RSS reaches
  3,409 MiB (immich) and 3,786 MiB (outline).
  [2026-09-14](measurements/2026-09-14-resident-large-workload.md).
- **Architecture C (ADR-0014): No-Go on the six-subject benchmark (2026-09-13),
  and evidence insufficient on the large subjects (2026-09-14). `oldProgram`:
  evidence insufficient.** C's
  cost-side conditions hold on the dependency-heavy subjects, but its reopen
  condition is a measured editor session on a 500+-file project, and none
  exists. What C could remove is bounded by `createProgram` + `getTypeChecker`, and the
  one compiler-side reuse already wired in (`oldProgram`) measured as no gain or
  a loss. Against that, C is a cache of snapshot-bound `ts.SourceFile`s whose
  invalidation is a second correctness surface, it makes the reuse gate's
  identity fast path load-bearing, and it would add memory to a process already
  at a 3,920 MiB peak on 557 files. `oldProgram`'s effect is consistent within an
  update shape and not across shapes, and TypeScript reports no structure reuse
  on immich and outline. **Next investment: none** until a measured session on a
  500+-file project exists. The workload observed on this repository alone
  ([2026-09-13](measurements/2026-09-13-resident-workload.md)) put mixed-set
  narrowing at No-Go.
- **Outside-root edits: No-Go on the candidate condition, nothing built.** A
  `/// <reference>` from an outside-root file can change in-root output with no
  change to the source-file sequence, so an outside-root edit stays a whole
  rebuild.
  [Design investigation](measurements/2026-09-13-outside-root-invalidation-design.md).

What is built, and what says so:

| Phase | Built | Evidence |
|---|---|---|
| 0 — canonical diagnostic order | yes | `test/diagnostic-order.test.ts` drives the adopted backend with `files` reversed and asserts the diagnostics, authority records and coverage bytes are identical. `check src --format json` order changed; announced in `CHANGELOG.md` |
| 1 — `ExtractedProject.modules` | yes | `test/extracted-modules.test.ts`: one entry per source file including a re-export-only barrel, and the per-file slices re-sum to the project aggregates on five fixture roots |
| 2 — resident session, full rebuild only | yes | `test/resident.differential.test.ts`: 79 cases, every mutation row comparing a resident generation's rendered bytes against a cold `analyze()` over the same tree. The config rows are compared against a cold run in a **separate process** (`test/support/cold-oracle.ts`) as well, because both in-process paths share one module registry and a stale config would make them agree on the same wrong answer |
| 3 — scoped fixed point | yes | `src/checker/impact.ts` (`summariesEqual`, `changedSymbols`, `impactClosure`) and `propagateScoped` in `src/checker/propagate.ts`. `test/impact.test.ts` pins the three decisions field by field; sixteen rows in the differential suite assert, for every mutation, that the scoped state equals `propagate` over the same summaries symbol for symbol *and* that the generation ran scoped |
| 4 — `openProject`, reverse-import re-extraction | yes | `openProject` in `src/checker/backend/legacy-ts.ts` holds the `ts.Program` and compares the compiler-side half of the reuse gate; `planUpdate` / `patchStore` in `src/checker/resident.ts` decide and apply the closure. Twenty-three rows in the differential suite assert the verdict (full or partial) **and** the re-extracted set, alongside byte equivalence with cold and the scoped-state oracle. The hazards each have their own row: a file added, a rename, an unresolved specifier resolved by an addition, a tsconfig `paths` change, a lockfile-invisible `node_modules` rewrite, an in-root `.d.ts`, a `declare global`, a program input outside the checked root, a file entering the program with no root name moving, a path the session never extracted, an unreported change set, and a failed generation followed by a recovery |
| 5 — benchmark, measured numbers | yes | `scripts/bench-resident.ts`; six subjects, six mutations, five scenarios, run in [2026-09-13](measurements/2026-09-13-resident-benchmark.md). `project-update` is broken down by `openProjectForMeasurement`, a measurement-only seam in `legacy-ts.ts`; `openProject` strips the breakdown and nothing in `src/core/` or `resident.ts` carries it |
| 5a — contract-only JSDoc narrowing | yes | `classifyJsDocEdit` and `contractOnlyNarrowing` in `src/checker/backend/legacy-ts.ts`, `narrowOffer` / `patchStore` in `src/checker/resident.ts`. 34 classifier rows in `test/backend.legacy-ts.test.ts` (including that the compiler parses all five contract tags as unknown tags) and 20 differential rows asserting bytes, scoped state, the narrowing verdict, the re-extracted set, and every store entry against a whole cold extraction and summarization |

What the differential suite covers row by row, how a package rewritten under
`node_modules` is detected, how a failed update is handled, and how a config
with imports is reloaded is recorded in
[`docs/resident-check-path.md`](resident-check-path.md#verification-record).

## Next measurement

1. `node scripts/bench-corpus.ts` after each analysis change, before claiming
   the change improved anything. The corpus refuses to run against a drifted
   checkout, so the number is comparable across commits.
2. `check src --coverage`'s `unresolved-by-reason` breakdown alongside it —
   currently `builtin-method` 17, and `external-module` carrying the rest.
3. Re-run M0.5 gates 3 and 4 once §6.2's resident path exists. Until then
   native's 1 ms re-query has nowhere in the product to appear, which is the
   second of §3.5's three conditions for reopening the backend decision.

## Milestones

| M | State | What is outstanding |
|---|---|---|
| M0 — specification, diagnostics, scope | **done** | `rfcs/` and `conformance/` are deferred by §9.1 to 1.0 or the first external adopter ([ADR-0010](adr/0010-when-governance-takes-effect.md)) |
| M0.5 — backend comparison | **done** | Linux not re-verified. Gates 3 and 4 worth re-running once §6.2 exists. Full record: [`docs/measurements/m0.5-backend-comparison.md`](measurements/m0.5-backend-comparison.md). A TypeScript 7 *shadow* backend runs the same pipeline for comparison only and changes no default ([2026-09-12](measurements/2026-09-12-ts7-shadow-analysis.md), hardening in [2026-09-12](measurements/2026-09-12-ts7-shadow-hardening.md), [2026-09-12](measurements/2026-09-12-callable-slot-handle.md), [2026-09-12](measurements/2026-09-12-literal-receiver-port.md), [2026-09-12](measurements/2026-09-12-instance-member-port.md)). Divergences: **0** on `src` and on every one of the gate's 14 roots; 16 across the five third-party repositories, with 0 high-risk, 0 authority increases or decreases, 0 `unknown` lost, and the CI decision agreeing everywhere — a figure that predates the last two ports and has not been re-measured. That is **not** feature parity: `NOT_PORTED` is `project:no-tsconfig-fallback` alone, a project-loading difference; every call-resolution shape `legacy-ts.ts` implements is ported. TypeScript 7 is 0.60x–1.16x of the adopted backend on those repositories. `node scripts/shadow-check.ts` is the regression gate |
| M1 — effects, unknown, coverage, diagnostics, init | **partial** | The resident session is incremental in extraction, summarization and propagation (phases 0–4 above); every other row of §6.2's invalidation table falls back to a whole re-extraction. Phase 6, CLI exposure, is not built. No versioned JSON Schema for the diagnostic format (§5.2). `@budget costUsd` parses and is never priced. Config has no `stubs` key |
| M2 — capabilities, budget, hooks, adapters, 50 stubs | **partial** | Four hooks, not more: `node:http`/`https`/`net`, `mysql2`, Prisma, Drizzle, MongoDB and every LLM SDK have none, so calling them is neither blocked nor recorded. `costUsd` and `llmCalls` are not enforced. Two adapters (Hono, Next.js App Router); Express, BullMQ, `worker_threads`, Server Actions, `middleware.ts`, the Pages Router and Edge have none. No `@budget` loop-pattern warnings. **Stubs are 6 client packages and 9 builtin namespaces, not 50 packages** |
| M3 — fix patches, agent protocol | **partial** | `fixes[].edits` exists for `AMB-E001` only. **`ambit agent` does not exist** — no protocol, no iteration limit, no approval gate for loosening fixes |
| M4 — editor, SBOM, npm | **partial** | Published as [`ambit-ts`](https://www.npmjs.com/package/ambit-ts): 0.1.0 on 2026-09-10 by hand, **without provenance**; 0.2.0 (`latest`) on 2026-09-14 through `release.yml`, with provenance. No editor integration of any kind. **`ambit sbom` does not exist**, nor do stub trust levels in diagnostics (§8). The runtime ships with the CLI, so installing Ambit pulls in `typescript` ([ADR-0009](adr/0009-package-name-and-single-package.md)) |
| M5 — Phase 1 exit criteria | **untouched** | An external pilot producing the evidence `ROADMAP.md` lists: sustained use on production-bound pull requests, and reviewer actions its reports caused. No sample, self-test, or synthetic benchmark substitutes for it |

What each milestone's acceptance criteria are is [`ROADMAP.md`](../ROADMAP.md).

## Contract tag support, at a glance

| Tag | Parsed | Statically checked | Runtime-enforced | Audit only |
|---|---|---|---|---|
| `@effects` | yes | yes (§4.2 rules 1–7) | — | — |
| `@capabilities` | yes | yes (caller→callee narrowing; literal HTTP target) | `fetch`, `node:fs`, `node:child_process`, `pg` | every decision recorded on the context |
| `@budget` | yes | validation only | `timeMs` only | — |
| `@entrypoint` | yes | warns without `@capabilities`; compared with a same-file `withAmbit` | establishes the context via `withAmbit` | — |
| `@boundary` | yes | excludes the body; reason required | — | counted in `--coverage` |
| `unknown` | n/a | propagated, reported, counted; `--strict` promotes it | — | — |

What each of these cannot do is [`docs/limitations.md`](limitations.md).
