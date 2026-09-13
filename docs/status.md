# Current status

Node.js v24.20.0, macOS (darwin arm64), Apple M1, 8 cores, 16 GiB. Every number
here was run, not estimated — but not all on the same day. Re-run **2026-09-13**:
`pnpm test`, `tsc --noEmit`, `biome ci`, `check src --coverage`,
`scripts/bench-corpus.ts`. Re-run **2026-09-11**: `check
test/fixtures/realistic-api --coverage`. Quoted from the runs archived in
[`docs/measurements/`](measurements/), not re-taken: the corpus median, the
latency figures, and the npm install evidence.

This file records *implementation status*, not design. The specification is
[`docs/DESIGN.md`](DESIGN.md), and nothing here changes it. The measurement runs
behind these numbers are archived in [`docs/measurements/`](measurements/).

## Verdict

**0.1.0 is published and not production-proven.** All five M0.5 backend gates
ran and the default backend is decided ([ADR-0001](adr/0001-analysis-backend.md)).
M1's incremental path exists and is not exposed: there is no CLI flag and no benchmark. M2–M4 are partial. M5 — the Phase 1 exit criterion —
is untouched, and cannot be moved by technical work.

What 0.1.0 asserts is `docs/DESIGN.md` §9.2's guaranteed surface under semver's
0.x rule: a breaking change to it may land in a minor release (§9.3) and is
announced in `CHANGELOG.md`. That is not the stability a 1.0 would claim.

## Key metrics

| Metric | Current | Target |
|---|---:|---:|
| **External adopters** | **0** | **1** |
| Authority increases an external team rejected or explicitly approved | 0 | > 0 |
| `unknown` rate, real third-party code (corpus median, 4,200 functions) | 52.9% | lower — no target (see below) |
| `unknown` rate, adopting-team-equivalent fixture (`realistic-api`) | 1.9% (1/53) | no target (see below) |
| `unknown` rate, Ambit's own source (`check src`) | 39.5% (163/413) | — |
| Authority Ambit sees in a third-party backend's data layer ([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)) | 940 stubbed call sites, up from 120 | — |
| Third-party backends `ambit diff` is silent on when nothing changed | **3** — Unleash ([2026-09-11](measurements/2026-09-11-third-party-diff-validation.md)), immich ([2026-09-11](measurements/2026-09-11-second-third-party-validation-immich.md)), outline ([2026-09-11](measurements/2026-09-11-third-third-party-validation-outline.md)) | — |
| `unknown` rate, second third-party backend (immich `server/src`, 3,191 functions) | 79.9% (2,550/3,191) | no target (see below) |
| `unknown` rate, third third-party backend (outline `server`, 2,245 functions) | 72.8% (1,635/2,245) | no target (see below) |
| Tests | 744 passing, 39 files | green |
| `tsc --noEmit` / `biome ci .` | pass / pass | pass |
| `check src` latency, 42 files | ~1.1 s (last timed at 40 files; not re-timed) | §3.5's 3 s allowance |
| Incremental / resident analysis | a resident session with a scoped fixed point **and a reverse-import closure re-extraction**, benchmarked against `analyze()` on six subjects ([2026-09-13](measurements/2026-09-13-resident-benchmark.md)); faster for edits with a small importer closure and for contract-only JSDoc edits at any fan-out ([2026-09-13](measurements/2026-09-13-resident-jsdoc-narrowing.md)); no CLI exposure | yes (§6.2), exposed and measured |
| Bundled stub packages | 6 DB/LLM clients, 9 builtin namespaces | 50 packages |
| Runtime hooks | 4 (`fetch`, `node:fs`, `node:child_process`, `pg`) | — |
| Framework adapters | 2 (Hono, Next.js App Router) | — |

**None of the four `unknown` rows has a target, and that is deliberate.**
`ROADMAP.md`'s 30% KPI is about **an adopting team's own code, with its own
`node_modules`, three months in.** No row here is that population: the corpus is
five repositories measured with no dependencies installed, `realistic-api` is a
fixture written in this repository, `src` is Ambit's own connection layer, and
immich is a third-party backend nobody here has adopted. Driving any of them to
30% would not satisfy the KPI. They are read as movement, not as progress
against it — the fixture's 1.9% least of all, since it says only that the
analysis handles the shapes it was given.

Three third-party runs now say something the rows themselves do not: **the
`unknown` rate and the usefulness of `diff` move independently**, and the third
run says it in the sharpest possible way. immich reads 79.5%, higher than
Unleash's 71.0%, and on it an unmodified tree produces no standing noise in
either mode, known authority is reported with the whole call path, and an
operation through an uncovered dependency is named under §6.4. outline reads
**69.0%, the lowest of the three, and is the subject with the only silent
miss** — a `fetch` added inside a route handler that `diff` reports nowhere.
All three runs also found that closing hundreds of call sites moved the rate
not at all. What the gate is worth has tracked *standing noise on an unchanged
tree*, *the precision of the delta*, and *whether a real increase is reported
at all* — not the absolute rate. Recorded as an observation from three
subjects. It is **not** a decision: `ROADMAP.md`'s KPI is about a population
none of the three runs measured, and nothing here changes it.

The second row replaced "serious incidents prevented". An incident that did not
happen is a counterfactual and cannot be observed; an authority increase that an
external team actually rejected or approved can be. Incident reduction stays
where it is measurable, as a Phase 1 exit metric in `ROADMAP.md`.

### Baseline commands

```sh
pnpm test                                                    # 744 tests, 39 files — pass
pnpm exec tsc --noEmit                                       # pass
./node_modules/.bin/biome ci .                               # pass
node src/cli/main.ts check src --coverage                    # exit 0
node src/cli/main.ts check test/fixtures/realistic-api --coverage   # exit 0
node src/cli/main.ts check test/fixtures/next-app --coverage        # exit 0
node src/cli/main.ts diff HEAD src                           # exit 0, ledger's approvals in place
node scripts/bench-corpus.ts                                 # median 52.9%
npm pack --dry-run                                           # 98 files, 192.1 kB packed
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
  `unknown` rate to 52.9%, in the order the measurement itself named:
  default-lib classification, by-reference callbacks (§4.2 rule 4), inlined
  self-walked bodies, then the locality rule on argument-position mutators.
- **`ambit diff` gives reviewable signal on a backend nobody here wrote.**
  Unleash (`Unleash/unleash@044461b`, `src/lib`, 596 files, 3,523 functions at
  the time, dependencies installed) was cloned untouched and put through the adopter's
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
  pnpm-workspace monorepo, 460 analyzed files, 3,061 functions at the time — was cloned
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
- **A third backend, chosen against what Ambit already answers, repeated the
  gate's properties and found the failure the first two could not.**
  `outline/outline@35dd15b9` — Koa 3 with inline route handlers, Sequelize 6,
  `bull` on ioredis, `@aws-sdk/client-s3`, yarn 4, 474 analyzed files, 1,951
  functions at the time — was cloned untouched and put through the same
  workflow. Zero standing noise in both modes; `fetch`, `node:fs` /
  `node:child_process` and their un-prefixed spellings reported with the whole
  call path; history diffs proportional to the change. Nothing from either
  earlier run was contradicted, and three findings were new. Two are now
  fixed: `check` and `diff` **did not terminate** when two declarations shared
  a symbol id, which a class declaring `run()` beside `static run()` produces;
  and authority added inside an **argument-position route handler** was
  reported nowhere at all, which the inline-callback owner closes (below). One
  is open: a §6.4 entry reads `? <unnamed>` when the receiver is a project
  class inheriting the method from a package — an ActiveRecord ORM's whole
  surface. The run is
  [2026-09-11](measurements/2026-09-11-third-third-party-validation-outline.md).
- **A route registered as an inline handler is no longer invisible.** Every
  function expression written directly as a call argument with no extracted
  ancestor is analyzed under one entry per file,
  `file.ts#<inline callbacks>`, and authority is compared as a multiset over
  the bodies it owns — so a handler gaining `fetch` is an increase even when a
  sibling in the same file already reaches the network (a per-file *set* would
  merge 495 such pairs on outline alone). outline's recorded E6 edit goes from
  exit 0 with no line anywhere to exit 1. **What this closes is the coverage
  hole, not per-handler identity**: authority moving from one handler to
  another leaves every count where it was, and §6.4's third shape reports that
  the bodies cannot be matched rather than calling it unchanged. On all three subjects the unmodified
  tree still reports **zero** increases at exit 0 in both modes, and every one
  of outline's 1,951 previously-emitted authority records is byte-identical.
  What moved is `--coverage` — bodies that were never walked are now analyzed,
  and `unknown` rises on all three — and `diff --strict`, which now fails on a
  one-line edit to a test file. The run is
  [2026-09-11](measurements/2026-09-11-inline-callback-owner.md);
  [ADR-0013](adr/0013-the-inline-callback-owner.md) says why one entry per
  file.
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
- **That a file-level report on an inline handler is reviewable enough.** An
  increase inside a route registered as an argument-position arrow now fails
  the gate, but it names the file rather than the handler, and on a count
  increase the witness path names *a* body holding the authority, which need
  not be the one that changed. Authority moving *between* two such handlers is
  not an increase at all — it is reported as §6.4's third shape, "the bodies
  cannot be matched", which keeps it out of silence but leaves the reader to
  find the handler in the git diff. No adopter has said whether that is enough
  ([`docs/open-questions.md`](open-questions.md)).
- **That `ambit diff --strict` is usable on a repository with inline test
  callbacks.** Those bodies are now analyzed and mostly reach calls no stub
  table covers, so one added line in a test file takes `--strict` from exit 0
  to exit 1 on all three third-party subjects, as a §6.4 report. Default
  `ambit diff` is unaffected.
- **That the corpus number generalizes.** The corpus deliberately does not
  install its dependencies, so a call into a package whose types are absent stays
  unresolved. The measurement can only be pessimistic, never flattering — but it
  also means 52.9% is not what an adopting team with a populated `node_modules`
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

**There is no adopter to point the next fix at.**

The blocker the third third-party run put first — `ambit diff` silent on
authority added inside an inline route handler — is closed
([ADR-0013](adr/0013-the-inline-callback-owner.md)). What it leaves behind is
not another silence but two questions only a user can answer: whether a
file-level increase is reviewable, and whether `--strict` is still usable on a
repository whose tests are written as inline callbacks. Both are listed under
"What is not proven" above, and neither can be settled here.

So the bottleneck is the one it was before:

**`unknown` on real third-party code, and the absence of an adopter to point the
next fix at.**

52.9% median means that on real code, more than half of all functions still
depend on a path the analysis did not reach. The largest remaining contributor
is `external-module`: calls into packages whose types are not installed. What
would move it next is measurable — the corpus prints the whole unresolved-name
histogram — but which of those names *matters* is a question only an adopter can
answer, and there is none.

On Ambit's own source the same figure is 39.4%, dominated by calls into the
`typescript` compiler API from the connection layer: the one file §3.4 means to
be replaceable.

The 2026-09-11 third-party run narrowed the question without closing it. On a
real backend with its dependencies installed, the unresolved-name histogram is
no longer anonymous — it names `knex.QueryBuilder.*` (458 sites at the top),
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

## The resident check path (§6.2)

Phases 0–5 of [`docs/resident-check-path.md`](resident-check-path.md) are
built. Phase 5 is `scripts/bench-resident.ts`, run once over six subjects and
recorded in full in
[2026-09-13](measurements/2026-09-13-resident-benchmark.md): cold `analyze()`,
a resident whole re-extraction, and a resident partial update, each with and
without `oldProgram`, for six mutations per subject. Every resident answer was
byte-equal to cold (144 of 144). Apple M1, one machine, not re-run on Linux.

**A re-check is faster than `analyze()` only where the reverse-import closure is
small.** A leaf or `ambit.config.ts` edit: 48 → 37 ms (realistic-api), 274 →
148 ms (got), 321 → 144 ms (trpc-server), 1,947 → 331 ms (drizzle-orm, 448
files), 10,361 → 2,200 ms (immich `server/src`, 557 files, dependencies
installed). An edit to the most widely imported file, and a JSDoc-only contract
edit placed **deliberately** in the widest-closure file that had a candidate,
re-extracted 419–432 files on the two large subjects and cost what `analyze()`
costs (1.9 s, 10.2 s); extraction is 77–85% of those. Those are high-fan-out,
worst-case-leaning rows, not a typical JSDoc edit, whose closure was not
measured. A file addition and a tsconfig edit are full rebuilds by design and
cost the same.

**A contract-only JSDoc edit now re-extracts the edited file alone**
([ADR-0015](adr/0015-contract-only-jsdoc-edits.md),
[2026-09-13](measurements/2026-09-13-resident-jsdoc-narrowing.md)). The same
widest-closure `@effects` mutation: 432/448 → 1/448 files and 2,275 → 345 ms on
drizzle-orm, 419/557 → 1/557 and 10,215 → 2,185 ms on immich, 39/49 → 1/49 and
652 → 474 ms on ambit-src, byte-equal to cold throughout, `S` and `I` unchanged.
`project-update` is 85–95% of what remains. A description, `@param` or other
non-contract JSDoc edit still pays the closure.

**Where partial extraction applies, `createProgram` + `getTypeChecker` is 82–96%
of the re-check.** The reuse gate's external-input hashing is 0.6–22 ms — 20 ms
over immich's 2,679 inputs (14.65 M chars, `node_modules` included) — and at
most 2% of `project-update` anywhere. **`oldProgram` buys nothing measurable** on
the five subjects without installed dependencies, and on immich passing it made
`project-update` 280–690 ms *slower* in every row where the program's structure
could be reused; the cause is not isolated. A resident process peaks 0–1,000 MiB
above a cold one (immich: 2.5–3.9 GiB).

**Architecture C (ADR-0014): No-Go for now.** The revisit condition —
`project-update` dominating — is met on every subject for small-closure edits.
C is still not the next investment, for two reasons. **A cheaper, lower-risk
lever is in front of it:** a JSDoc-only edit re-extracts the whole
reverse-import closure — 419–432 files through the checker-driven pass 2 in the
worst-case rows — although pass 2 never reads a callee's JSDoc; that narrowing
was left untaken in phase 4 until a benchmark justified it. **And the workload is
unmeasured:** how often each kind of edit happens in a real editor session, and
how wide a typical JSDoc edit's closure is, are not known. What C could remove is bounded by
`createProgram` + `getTypeChecker` on a partial leaf update: about 27 ms
(realistic-api), 130–140 ms (got, trpc-server), 420 ms (ambit-src, whose program
reads 640 external inputs), 280 ms (drizzle-orm), 1.8 s on immich (1.4 s without
`oldProgram`); the real
saving is smaller, because the changed file is still parsed and the checker
still merges globals. It does not shorten the extraction-bound rows, and the
one piece of compiler-side reuse already in place (`oldProgram`) measured as no
gain or a loss. Against that, C is a cache of
snapshot-bound `ts.SourceFile`s whose invalidation is a second correctness
surface, it makes the reuse gate's identity fast path load-bearing, and it would
add memory to a process already at 3.9 GiB peak on 557 files. What would change
the verdict is in `docs/open-questions.md`.

What is built, and what says so:

| Phase | Built | Evidence |
|---|---|---|
| 0 — canonical diagnostic order | yes | `test/diagnostic-order.test.ts` drives the adopted backend with `files` reversed and asserts the diagnostics, authority records and coverage bytes are identical. `check src --format json` order changed; announced in `CHANGELOG.md` |
| 1 — `ExtractedProject.modules` | yes | `test/extracted-modules.test.ts`: one entry per source file including a re-export-only barrel, and the per-file slices re-sum to the project aggregates on five fixture roots |
| 2 — resident session, full rebuild only | yes | `test/resident.differential.test.ts`: 79 cases, every mutation row comparing a resident generation's rendered bytes against a cold `analyze()` over the same tree. The config rows are compared against a cold run in a **separate process** (`test/support/cold-oracle.ts`) as well, because both in-process paths share one module registry and a stale config would make them agree on the same wrong answer |
| 3 — scoped fixed point | yes | `src/checker/impact.ts` (`summariesEqual`, `changedSymbols`, `impactClosure`) and `propagateScoped` in `src/checker/propagate.ts`. `test/impact.test.ts` pins the three decisions field by field; sixteen rows in the differential suite assert, for every mutation, that the scoped state equals `propagate` over the same summaries symbol for symbol *and* that the generation ran scoped |
| 4 — `openProject`, reverse-import re-extraction | yes | `openProject` in `src/checker/backend/legacy-ts.ts` holds the `ts.Program` and compares the compiler-side half of the reuse gate; `planUpdate` / `patchStore` in `src/checker/resident.ts` decide and apply the closure. Twenty-three rows in the differential suite assert the verdict (full or partial) **and** the re-extracted set, alongside byte equivalence with cold and the scoped-state oracle. The hazards each have their own row: a file added, a rename, an unresolved specifier resolved by an addition, a tsconfig `paths` change, a lockfile-invisible `node_modules` rewrite, an in-root `.d.ts`, a `declare global`, a program input outside the checked root, a file entering the program with no root name moving, a path the session never extracted, an unreported change set, and a failed generation followed by a recovery |
| 5 — benchmark, measured numbers | yes | `scripts/bench-resident.ts`; six subjects, six mutations, five scenarios, run in [2026-09-13](measurements/2026-09-13-resident-benchmark.md). `project-update` is broken down by `openProjectForMeasurement`, a measurement-only seam in `legacy-ts.ts`; `openProject` strips the breakdown and nothing in `src/core/` or `resident.ts` carries it |
| 5a — contract-only JSDoc narrowing | yes | `classifyJsDocEdit` and `contractOnlyNarrowing` in `src/checker/backend/legacy-ts.ts`, `narrowOffer` / `patchStore` in `src/checker/resident.ts`. 32 classifier rows in `test/backend.legacy-ts.test.ts` (including that the compiler parses all five contract tags as unknown tags) and 20 differential rows asserting bytes, scoped state, the narrowing verdict, the re-extracted set, and every store entry against a whole cold extraction and summarization |

The differential suite covers §6.2's equivalence law over an ordinary edit, a
JSDoc-only edit, authority added and removed, a file added, a file deleted, an
unresolved import resolved by adding the file it names, a specifier re-pointed
at a newly added file, a rename as delete-plus-add, a re-export barrel
re-pointed, a cycle, a callback edge gained and lost, an `ambit.config.ts`
contract added/changed/removed, a change and its revert, and ten sequential
mutations in one session.

Phase 3 added to it: an edit no summary records (`S = ∅`), a direct effect
added and removed, a caller whose callee changed identity, a call edge added
and removed, a deleted callee reached through the **old** reverse-call graph
only, an authority added and removed inside a cycle, an overload
implementation swapped under unchanged signatures, the inline-callback owner
gaining and losing a body, `@boundary` added and removed, `AMB-W006` rebuilt
from the per-file matched config keys, a revert compared on the internal state
as well as the report, twelve sequential mutations, §3.5's three gate-3
mutations from `scripts/m05-probe/mutations.ts`, a row proving the scoped path
runs while the fingerprint refuses extraction reuse, and a mutation on a copy of
`src/` itself.

Phase 4 added twenty-three more, and each asserts the **verdict** and the
**re-extracted set** rather than equivalence alone — a row that asserted only
equivalence would pass just as well against a session that re-extracted
everything, which is the thing phase 4 stops doing. Partial: an edited file and
its transitive importers, a leaf nothing imports, a re-pointed barrel that
declares no function of its own, a deleted file followed through the old import
graph with no stale edge left behind, a config-only change that re-summarizes
every file and re-extracts only the config, a mid-edit syntax error, ten
sequential partial updates, the three gate-3 mutations taken through the
closure, and a one-file edit on a copy of `src/`. Full: a file added, a rename,
an unresolved specifier whose target arrives, a tsconfig `paths` change, a
changed `package.json`, a package rewritten in place under `node_modules`, an
in-root `.d.ts`, a `declare global`, a source file the program reads from
outside the checked root, a path this session never extracted, a caller that
reports no change set at all, a file that enters the program without a root name
moving (an explicit `files:` tsconfig), and the first update after a failed one. One more row is about the import graph rather than the gate: a file
that depends on another only through an `import("…")` **type node**, which
writes no import statement and still resolves a call into the named file.

**A package rewritten in place under `node_modules` moves neither the lockfile
nor `package.json`**, so the disk-side fingerprint reads "nothing changed". What
sees it is the backend session, which hashes **every** program input that is not
an in-root implementation file — in-root `.d.ts`, `node_modules` typings,
sources pulled in from outside the root, and the compiler's own `lib.*.d.ts`.
Nothing is excluded by path. An earlier version skipped the default lib's
directory; it skipped the whole directory rather than the default libs
(`typescript.d.ts` lives there too), and the argument for it — those files are a
function of the engine version — does not survive the threat model the hash
exists for, since a version string is not a proof of content identity. Measured
at 82 inputs, 2.94 M characters, 4.5 ms on that subject. That clause is what let
`ProjectFingerprint`'s permanent "resolved compiler options are not available"
unknown be removed: it was replaced, not deleted.

**Building the closure found one defect that predates it.**
`ExtractedModule.imports` did not follow an `import("…")` type node, so a file
whose only dependency on another is a parameter annotated
`s: import("./svc.ts").Svc` held a resolved call edge into `svc.ts` with no
import edge under it. Probed against the compiler, not reasoned about; fixed in
`collectImportTargets`, and the row that covers it fails without the fix.

**Omitting a change set is not the same as passing an empty one.**
`session.update()` re-extracts everything, because a caller that does not track
changes cannot be closed over; `session.update([])` is a caller asserting that
nothing under the root moved. That difference is where §6.2's one open gap — a
change under the root that the caller never reports — is visible to a caller. Five failure shapes — a tsconfig that stopped
parsing, a config that no longer loads, both broken at once, two declarations
colliding on one symbol id (§4.1), and a tree with nothing analyzable in it —
each prove the same four things: the update reports failure, the previous generation stays committed
byte-identically, it is **not** served as the current answer, and a later valid
update succeeds, **and the cold path fails on the same tree with the same
message** — the doubly-broken row is what makes that last clause mean something.
One self-hosting row runs a session on `src/` itself across two generations.

**An `ambit.config.ts` that imports anything is loaded in a worker thread**,
because Node's module registry would otherwise hand the config a cached copy of
what that module exported before it was edited. "Imports anything" means any
static `import` or `export … from`, bare or relative, however it is written —
not the size of the hash closure, which counts only resolved *relative*
specifiers and so missed both a bare `ambit-ts/config` import and a relative one
written across several lines. A config that imports nothing pays nothing. The fingerprint's `configHash` covers the same
transitive closure of *relative* imports; a bare specifier is not followed,
because a change to an installed package is a resolution change that §6.2
already answers with a whole rebuild. What the closure walk cannot decide — a
specifier resolving to no file on disk, a dynamic import — goes into
`undecidable`. Starting a thread is authority, so `analyze` and the resident
entry points declare `process` alongside `fs_read`.

One gap is stated rather than closed: a package rewritten in place moves neither
`configHash` (bare specifiers are outside the closure by design) nor
`resolutionHash` (the lockfile did not change). The config is still evaluated
fresh, so the answer is right; what would be wrong is the fingerprint's reuse
decision, and it is covered today only because `undecidable` is permanently
non-empty. Phase 4 removes that entry and must answer this first.

**What the design's adversarial table asks for and the suite does not yet
cover**, so the next phase starts from a known list rather than from a
rediscovery: the gate-3 mutation set in `scripts/m05-probe/mutations.ts`, an
overload implementation swapped, the inline-callback owner gaining or losing a
body, `@boundary` added or removed, a `paths` change in tsconfig, a dependency
installed or updated, a mid-edit syntax error, and self-hosting with a real
`src/` file *touched* — the self-hosting row runs two unmutated generations on
`src/` and does its mutation on a copy of `test/fixtures/realistic-api` instead,
because other test files read `src/` concurrently.

The snapshot-bound-state rule (§6.2, §3.4) is asserted two ways:
`test/architecture.test.ts` forbids `src/checker/resident.ts` from importing
`typescript` at all, and the differential suite clones the committed store with
`structuredClone`, which throws on any retained compiler object or closure.

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
| M0.5 — backend comparison | **done** | Linux not re-verified. Gates 3 and 4 worth re-running once §6.2 exists. Full record: [`docs/measurements/m0.5-backend-comparison.md`](measurements/m0.5-backend-comparison.md). A TypeScript 7 *shadow* backend now runs the same pipeline for comparison only, measured in [2026-09-12](measurements/2026-09-12-ts7-shadow-analysis.md) and hardened in [2026-09-12](measurements/2026-09-12-ts7-shadow-hardening.md), again in [2026-09-12](measurements/2026-09-12-callable-slot-handle.md), again in [2026-09-12](measurements/2026-09-12-literal-receiver-port.md) and again in [2026-09-12](measurements/2026-09-12-instance-member-port.md) — it changes no default. Divergences on `src` 137 → 4 → **0**, and every one of the gate's 14 roots is now at 0; across the five third-party repositories 260 → 16, with 0 high-risk left, 0 authority increases, 0 decreases, 0 `unknown` lost, and the CI decision agreeing everywhere. Those numbers say the two engines no longer disagree in any way that reaches authority and that nothing accounts for — **not** that the shadow backend is at feature parity: `NOT_PORTED` is now `project:no-tsconfig-fallback` alone, a project-loading difference. Every call-resolution shape `legacy-ts.ts` implements is ported — `resolution:literal-receiver` (the four rows on `src`, one site at `cli/analyze.ts:91`) and `resolution:instance-member` (the seven left on `backend-smoke`, one site at `call-resolution.ts:172`). The corpus figure of 16 predates both ports and has not been re-measured. TypeScript 7 is 0.60x–1.16x of the adopted backend on those repositories, so the performance case is weaker than `src` alone suggested. `node scripts/shadow-check.ts` is the regression gate |
| M1 — effects, unknown, coverage, diagnostics, init | **partial** | A resident session exists (`src/checker/resident.ts`) and is **incremental in extraction, summarization and propagation**: an update re-extracts the reverse-import closure of what the caller reported, re-summarizes that closure (or every file, when the config's value moved), and scopes the fixed point to the functions whose summaries moved plus their callers — phases 0–4 of [`docs/resident-check-path.md`](resident-check-path.md). Every other row of §6.2's invalidation table falls back to a whole re-extraction. Phase 5's benchmark ([2026-09-13](measurements/2026-09-13-resident-benchmark.md)) puts a leaf or config edit at 1.3×–5.9× faster than `analyze()` and a JSDoc-only edit in a deliberately high-fan-out file on a large subject at the same cost — since narrowed to the edited file for contract tags, 5.8× and 4.9× faster than `analyze()` on drizzle-orm and immich ([2026-09-13](measurements/2026-09-13-resident-jsdoc-narrowing.md)); phase 6 (CLI exposure) is not built. No versioned JSON Schema for the diagnostic format (§5.2). `@budget costUsd` parses and is never priced. Config has no `stubs` key |
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
