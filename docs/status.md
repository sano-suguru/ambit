# Current status

Node.js v24.20.0, macOS (darwin arm64), Apple M1, 8 cores, 16 GiB. Every number
here was run, not estimated — but not all on the same day. Re-run **2026-09-11**:
`pnpm test`, `tsc --noEmit`, `biome ci`, `check src --coverage`, `check
test/fixtures/realistic-api --coverage`. Quoted from the runs archived in
[`docs/measurements/`](measurements/), not re-taken: the corpus median, the
latency figures, and the npm install evidence.

This file records *implementation status*, not design. The specification is
[`docs/DESIGN.md`](DESIGN.md), and nothing here changes it. The measurement runs
behind these numbers are archived in [`docs/measurements/`](measurements/).

## Verdict

**0.1.0 is published and not production-proven.** All five M0.5 backend gates
ran and the default backend is decided ([ADR-0001](adr/0001-analysis-backend.md)).
M1 has no incremental path. M2–M4 are partial. M5 — the Phase 1 exit criterion —
is untouched, and cannot be moved by technical work.

What 0.1.0 asserts is `docs/DESIGN.md` §9.2's guaranteed surface under semver's
0.x rule: a breaking change to it may land in a minor release (§9.3) and is
announced in `CHANGELOG.md`. That is not the stability a 1.0 would claim.

## Key metrics

| Metric | Current | Target |
|---|---:|---:|
| **External adopters** | **0** | **1** |
| Authority increases an external team rejected or explicitly approved | 0 | > 0 |
| `unknown` rate, real third-party code (corpus median, 4,200 functions) | 52.6% | lower — no target (see below) |
| `unknown` rate, adopting-team-equivalent fixture (`realistic-api`) | 1.9% (1/53) | no target (see below) |
| `unknown` rate, Ambit's own source (`check src`) | 37.8% (128/339) | — |
| Authority Ambit sees in a third-party backend's data layer ([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)) | 940 stubbed call sites, up from 120 | — |
| Third-party backends `ambit diff` is silent on when nothing changed | **2** — Unleash ([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)), immich ([2026-09-11](measurements/2026-09-11-second-third-party-validation-immich.md)) | — |
| `unknown` rate, second third-party backend (immich `server/src`, 3,061 functions) | 79.5% (2,432/3,061) | no target (see below) |
| Tests | 549 passing, 33 files | green |
| `tsc --noEmit` / `biome ci .` | pass / pass | pass |
| `check src` latency, 40 files | ~1.1 s | §3.5's 3 s allowance |
| Incremental / resident analysis | no | yes (§6.2) |
| Bundled stub packages | 6 DB/LLM clients, 9 builtin namespaces | 50 packages |
| Runtime hooks | 4 (`fetch`, `node:fs`, `node:child_process`, `pg`) | — |
| Framework adapters | 2 (Hono, Next.js App Router) | — |

**None of the three `unknown` rows has a target, and that is deliberate.**
`ROADMAP.md`'s 30% KPI is about **an adopting team's own code, with its own
`node_modules`, three months in.** No row here is that population: the corpus is
five repositories measured with no dependencies installed, `realistic-api` is a
fixture written in this repository, and `src` is Ambit's own connection layer.
Driving any of them to 30% would not satisfy the KPI. They are read as movement,
not as progress against it — the fixture's 1.9% least of all, since it says only
that the analysis handles the shapes it was given.

The second row replaced "serious incidents prevented". An incident that did not
happen is a counterfactual and cannot be observed; an authority increase that an
external team actually rejected or approved can be. Incident reduction stays
where it is measurable, as a Phase 1 exit metric in `ROADMAP.md`.

### Baseline commands

```sh
pnpm test                                                    # 512 tests, 31 files — pass
pnpm exec tsc --noEmit                                       # pass
./node_modules/.bin/biome ci .                               # pass
node src/cli/main.ts check src --coverage                    # exit 0
node src/cli/main.ts check test/fixtures/realistic-api --coverage   # exit 0
node src/cli/main.ts check test/fixtures/next-app --coverage        # exit 0
node src/cli/main.ts diff HEAD src                           # exit 0, ledger's approvals in place
node scripts/bench-corpus.ts                                 # median 52.6%
npm pack --dry-run                                           # 96 files, 161.8 kB packed
```

`pnpm exec biome ci .` returns 1 in one local shell because of a user-installed
command wrapper, not because of this repository — `pnpm exec biome --version`
fails the same way. Run the binary directly to see the real exit code. CI runs
`pnpm exec biome ci .` on GitHub Actions, where no such wrapper exists.

## What is proven

Each of these was measured, and the run is archived.

- **Effect propagation works on code nobody here wrote.** The fixed corpus in
  `test/corpus/corpus.json` — five server-side TypeScript projects (`hono`,
  `trpc-server`, `elysia`, `got`, `drizzle-orm`), pinned by commit SHA and by
  the git tree object of each measured subtree — went from a 76.7% median
  `unknown` rate to 52.6%, in the order the measurement itself named:
  default-lib classification, by-reference callbacks (§4.2 rule 4), inlined
  self-walked bodies, then the locality rule on argument-position mutators.
- **`ambit diff` gives reviewable signal on a backend nobody here wrote.**
  Unleash (`Unleash/unleash@044461b`, `src/lib`, 596 files, 3,523 functions,
  dependencies installed) was cloned untouched and put through the adopter's
  workflow. The untouched tree reports **no** increase, so the gate has no
  standing noise; four authority-expansion edits an agent might make were then
  applied one at a time. `fetch`, `node:fs.writeFileSync` and
  `node:child_process.execSync` are each reported with the whole call path to
  the controller. A knex `del()` added inside an existing read method was
  **missed** — and fixing the cause (naming a receiver from the package type
  that describes it) took that repository's stubbed call sites from 120 to 940
  and turned the miss into exit 1 naming the operation. The two misses that
  survived that change were operations no table named — `ky`, the HTTP client
  that repository actually uses, and the same `fs` / `child_process` edit
  written without the `node:` prefix, the spelling that repository uses
  throughout — and both are now closed: seven `ky` rows, and a lookup that
  reads the two spellings of a builtin specifier as the one module they are.
  Re-run on the same checkout, each edit exits **1** with the path to the
  controller, and that repository's stubbed call sites went 940 → **953** with
  `diff HEAD` still silent on the untouched tree. The run is
  [2026-09-11](measurements/2026-09-11-third-party-diff-validation.md).
- **The lessons from the first third-party backend generalize to a second
  one, and that run found the blocker the first could not.**
  `immich-app/immich@2a62622` — NestJS 12, ESM, kysely, bullmq on ioredis, a
  pnpm-workspace monorepo, 460 analyzed files, 3,061 functions — was cloned
  untouched and put through the same workflow. Every name in its top-ten
  unresolved histogram is a receiver named from its declared type, which is the
  rule the Unleash run added, and `fetch`, `node:fs` / `node:child_process` and
  their un-prefixed spellings are each reported with the whole call path
  through two NestJS indirections to the controller. Nothing from the first run
  was contradicted. What was new is that `diff` compared **two different
  environments**: only `<git root>/node_modules` was linked into the base
  checkout, and a pnpm workspace keeps a package's dependencies beside the
  package, so an **unmodified** tree reported 257 authority increases, 1,182
  unresolvable gains and exit 1 in both modes. Linking every directory from the
  repository root down to the checked one takes that to **no increase, exit 0
  in both modes**, all twelve injected-change outputs byte-identical to a
  single-package control, and `HEAD~20` over 443 changed files to no authority
  increase and 35 unresolvable gains. Unleash re-measured on the same checkout
  is unchanged. The run is
  [2026-09-11](measurements/2026-09-11-second-third-party-validation-immich.md).
- **The gate is real and it has cost something.** `ambit diff HEAD~1 src` runs
  as a **gating** CI step with `continue-on-error` removed. The change that
  introduced the approval ledger was itself a legitimate authority increase:
  `diff HEAD src` exited 1 with no ledger and 0 with five approval lines, the
  only difference between the two runs being `ambit.approvals.md`.
- **The package installs and runs from the registry.** `ambit-ts@0.1.0` was
  installed from npm into a scratch project outside this repository and run
  there: a file whose `pure` declaration breaks two calls away exits 1 and
  prints the path (`priceOrder` → `applyTax` → `fetch`).
- **Runtime enforcement blocks real operations.** `test/e2e.runtime.test.ts`
  drives a real socket, real files, a real child process, a real `pg@8` client
  and a real Hono server through the installed package; the Next.js denials each
  assert the operation was never reached.
- **The backend is replaceable in the way §3.4 claims.**
  `test/backend.conformance.test.ts` asserts against the `TsBackend` interface
  rather than against a compiler, and `test/architecture.test.ts` enforces that
  only `legacy-ts.ts` imports `typescript`.

## What is not proven

- **That anyone wants this.** Zero external adopters, zero pilot teams, zero
  observed incidents prevented. This is the single most important row above, and
  no amount of test coverage substitutes for it.
- **That the corpus number generalizes.** The corpus deliberately does not
  install its dependencies, so a call into a package whose types are absent stays
  unresolved. The measurement can only be pessimistic, never flattering — but it
  also means 52.6% is not what an adopting team with a populated `node_modules`
  would see, in either direction.
- **Linux.** The M0.5 comparison ran on darwin/arm64 only. Nothing is claimed
  about Linux either way.
- **Performance under load.** The latency figures were taken on a machine that
  was not quiescent for all of them, and §3.5's performance gate has not been
  re-run. The runtime overhead of a context and a `decode` is unmeasured, as is
  the cost of going through a replaced function.
- **Provenance.** 0.1.0 was published by hand and carries no attestation. The
  trusted publisher is configured now, so 0.2.0 onward goes out through
  `.github/workflows/release.yml` — **which has therefore never run.**

## Current bottleneck

**`unknown` on real third-party code, and the absence of an adopter to point the
next fix at.**

52.6% median means that on real code, more than half of all functions still
depend on a path the analysis did not reach. The largest remaining contributor
is `external-module`: calls into packages whose types are not installed. What
would move it next is measurable — the corpus prints the whole unresolved-name
histogram — but which of those names *matters* is a question only an adopter can
answer, and there is none.

On Ambit's own source the same figure is 38.5%, dominated by calls into the
`typescript` compiler API from the connection layer: the one file §3.4 means to
be replaceable.

The 2026-09-11 third-party run narrowed the question without closing it. On a
real backend with its dependencies installed, the unresolved-name histogram is
no longer anonymous — it names `knex.QueryBuilder.*` (448 sites at the top),
`express.Response.*`, `supertest.Test.*` — so *which* names matter is now
answerable there. What it also showed is that `unknown` and the gate are less
coupled than the rate suggests: a *known* effect added inside an `unknown`
symbol fails the comparison already, because what is compared is the effect set
and being `unknown` beside it changes neither side. What had no line at all was
the gain the analysis cannot resolve — an outbound call through a client no
table covers, added to a symbol that was already `unknown`.

That one is now decided and implemented (§6.4,
[ADR-0012](adr/0012-reporting-an-unresolvable-gain.md)): the authority record
carries the operations a function's own body could not resolve, `ambit diff`
reports a gain in them, and `diff --strict` is what makes it fail. Measured on
the same backend: 3 symbols over `HEAD~20..HEAD` — the number taken by hand
before the design — disjoint from the 3 `unknownGained` already named, and
silent on the untouched tree with the flag and without it
([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md), the
last section). What that does **not** close is the one thing an adopter would
want next: `--strict` is only usable where its reports can be closed, and a
package no bundled table covers has no exit short of `@boundary`
([`docs/limitations.md`](limitations.md)).

## Next measurement

1. `node scripts/bench-corpus.ts` after each analysis change, before claiming
   the change improved anything. The corpus refuses to run against a drifted
   checkout, so the number is comparable across commits.
2. `check src --coverage`'s `unresolved-by-reason` breakdown alongside it —
   currently `builtin-method` 13, and `external-module` carrying the rest.
3. Re-run M0.5 gates 3 and 4 once §6.2's resident path exists. Until then
   native's 1 ms re-query has nowhere in the product to appear, which is the
   second of §3.5's three conditions for reopening the backend decision.

## Milestones

| M | State | What is outstanding |
|---|---|---|
| M0 — specification, diagnostics, scope | **done** | `rfcs/` and `conformance/` are deferred by §9.1 to 1.0 or the first external adopter ([ADR-0010](adr/0010-when-governance-takes-effect.md)) |
| M0.5 — backend comparison | **done** | Linux not re-verified. Gates 3 and 4 worth re-running once §6.2 exists. Full record: [`docs/measurements/m0.5-backend-comparison.md`](measurements/m0.5-backend-comparison.md) |
| M1 — effects, unknown, coverage, diagnostics, init | **partial** | No resident or incremental check (§6.2) — a re-check costs the same as a first check. No versioned JSON Schema for the diagnostic format (§5.2). `@budget costUsd` parses and is never priced. Config has no `stubs` key |
| M2 — capabilities, budget, hooks, adapters, 50 stubs | **partial** | Four hooks, not more: `node:http`/`https`/`net`, `mysql2`, Prisma, Drizzle, MongoDB and every LLM SDK have none, so calling them is neither blocked nor recorded. `costUsd` and `llmCalls` are not enforced. Two adapters (Hono, Next.js App Router); Express, BullMQ, `worker_threads`, Server Actions, `middleware.ts`, the Pages Router and Edge have none. No `@budget` loop-pattern warnings. **Stubs are 5 client packages and 9 builtin namespaces, not 50 packages** |
| M3 — fix patches, agent protocol | **partial** | `fixes[].edits` exists for `AMB-E001` only. **`ambit agent` does not exist** — no protocol, no iteration limit, no approval gate for loosening fixes |
| M4 — editor, SBOM, npm | **partial** | Published as [`ambit-ts`](https://www.npmjs.com/package/ambit-ts) 0.1.0 on 2026-09-10, **without provenance**. No editor integration of any kind. **`ambit sbom` does not exist**, nor do stub trust levels in diagnostics (§8). No pilot team. The runtime ships with the CLI, so installing Ambit pulls in `typescript` ([ADR-0009](adr/0009-package-name-and-single-package.md)) |
| M5 — Phase 1 exit criteria | **untouched** | A real team showing a measured change in delivery speed and incident rate. No sample, self-test, or synthetic benchmark substitutes for it |

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
