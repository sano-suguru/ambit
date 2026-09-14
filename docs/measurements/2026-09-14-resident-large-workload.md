# The resident path on three large subjects, per update shape

Run 2026-09-13 → 2026-09-14, Node.js v24.20.0, TypeScript 6.0.3
(`typescript-legacy`), macOS (darwin arm64), Apple M1, 8 cores, 16 GiB — the
machine of [phase 5](2026-09-13-resident-benchmark.md). Nothing in `src/`
changed. `docs/status.md` carries the verdict.

**Synthetic.** Every update below is a mutation the benchmark script writes. It
measures what one update of each shape costs on a large project, not how often
any shape happens. No editor or agent session ran against these subjects, and
nothing here is an adopter workload.

## Procedure

`scripts/bench-resident.ts`, extended for this run with four mutations
(`deletion`, `outside-root`, `leaf-rotate`, `alternate`), a `--scenarios` filter
and an `--outline` subject; phase 5's six mutations are unchanged.

```sh
W=leaf,hub,jsdoc,outside-root,addition,deletion,tsconfig
node scripts/bench-resident.ts --subjects drizzle-orm --mutations $W --scenarios cold,partial,partial-noold --warmup 2 --iterations 7
node scripts/bench-resident.ts --subjects drizzle-orm --mutations leaf-rotate,alternate --scenarios partial,partial-noold --warmup 1 --iterations 10
node scripts/bench-resident.ts --immich <co> --subjects immich-server --mutations $W --scenarios cold,partial,partial-noold --warmup 2 --iterations 5
node scripts/bench-resident.ts --immich <co> --subjects immich-server --mutations leaf,leaf-rotate,alternate --scenarios partial,partial-noold --warmup 1 --iterations 10
node scripts/bench-resident.ts --immich <co> --subjects immich-server --mutations leaf,config --scenarios partial-noold,partial --warmup 2 --iterations 7   # second, independent run
node scripts/bench-resident.ts --outline <co> --subjects outline-server --mutations leaf,hub,jsdoc,outside-root,deletion,tsconfig --scenarios cold,partial,partial-noold --warmup 1 --iterations 5
```

Sequential, one child process per subject × mutation × scenario. **One
contamination:** the outline dependency install ran during drizzle-orm's first
row; drizzle-orm's `leaf · cold` (p50 2,628, p25–p75 2,258–2,852) is
inflated by it and is not quoted below. Its other cold rows are 2,102–2,200.

- `cold` — `analyze()`; `partial` — the product's `update(changes)`, whatever
  verdict it reaches ("resident current"); `partial-noold` — the same with
  `oldProgram` withheld through `openProjectForMeasurement`.
- `outside-root` edits a project file outside the root, found by editing
  candidates until the session answers `full`, and reports `[]`.
  `deletion` removes a different one-function file each iteration.
  `leaf-rotate` edits five different leaves in turn; `alternate` alternates a
  leaf code edit with the contract-only `@effects` toggle. Same-leaf ×10 is
  `leaf` at 10 iterations.
- **Every resident row's last answer was byte-equal to a cold `analyze()`: 52
  of 52.**

## Subjects

| subject | checked root files / functions | other program inputs (files, chars) | of which `node_modules` (approx.) | hub closure |
|---|---:|---:|---:|---:|
| drizzle-orm (corpus) | 448 / 2,652 | 63, 2.87 M (lib only) | 0 | 432 |
| immich `server/src` @2a626220 | 557 / 3,192 | 2,679, 14.65 M | ≈ 2,540 | 427 |
| outline `server/` @35dd15b9, root tsconfig (`app`, `shared`, `plugins` in the program) | 793 / 2,246 | 7,106, 45.19 M | ≈ 5,670 | 728 |

The `node_modules` column comes from a separate probe's `getSourceFiles()`
(immich 3,207 program files, outline 7,889); it is an approximate split, not a
benchmark output. outline's leaves are `*.test.ts` files under `server/`: its
tsconfig does not exclude tests, so they are root files.

## Latency per update shape (total ms, p50 / p75; `partial` = product)

| shape | drizzle cold | drizzle resident | immich cold | immich resident | outline cold | outline resident |
|---|---|---|---|---|---|---|
| leaf code | — (contaminated) | 364 / 483 | 10,298 / 10,361 | 2,009 / 2,017 | 16,297 / 16,546 | 5,504 / 5,880 |
| hub code | 2,200 / 2,202 | 2,013 / 2,187 | 10,243 / 10,503 | 10,584 / 10,932 | 17,694 / 18,251 | 19,884 / 21,861 |
| contract-only | 2,102 / 2,169 | 386 / 397 | 9,681 / 9,772 | 1,814 / 1,824 | 16,076 / 16,240 | 4,568 / 4,602 |
| outside-root (full) | n/a — root is the project | — | 9,829 / 9,899 | 10,406 / 10,439 | 16,332 / 16,360 | 20,260 / 21,371 |
| add file (full) | 2,158 / 2,182 | 1,965 / 1,989 | 9,739 / 9,816 | 10,272 / 10,747 | not run | — |
| delete file | 2,143 / 2,193 | 364 / 369 (partial) | 9,604 / 9,805 | 1,444 / 1,569 (partial) | 16,280 / 16,301 | 3,813 / 3,868 (partial) |
| tsconfig (full) | 2,184 / 2,226 | 1,956 / 2,009 | 10,079 / 10,430 | 10,430 / 10,474 | 17,117 / 17,271 | 19,820 / 19,845 |

A deletion of a file with no importers is answered as a partial update
(0 files re-extracted) on all three subjects; an addition is a whole rebuild.

**A whole rebuild in a resident process costs more than cold on the two
dependency-heavy subjects**: immich +2% to +6% (outside-root, add, tsconfig,
hub), outline +12% to +24% (tsconfig, hub, outside-root); drizzle-orm −8% to
−10%. On outline, resident extraction alone (14.2–14.5 s) is near cold's whole
run. The cause is not isolated; the resident process holds the previous
generation while building the next (peak RSS below).

### Sequences (p50, every update re-extracted 1 file)

| sequence | drizzle | immich | series note |
|---|---:|---:|---|
| same leaf ×10 | — | 1,756 (p75 1,820) | flat: 1,698–1,884 |
| five leaves in turn | 347 (p75 361) | 2,081 (p75 2,115) | flat |
| code / contract alternating (rerun) | 323 (p75 334) | 1,724 (p75 1,751) | flat: 309–431 / 1,665–2,167 |

The first `alternate` run is discarded: its contract half inserted the same
`@effects fs_write` into the original text every time (S = 0 where the
standalone contract edit has S = 1). The script was fixed and both subjects
rerun; the rerun has S = 1. Code and contract updates in the sequence cost the
same within noise, because both re-extract one file and are bound by
`project-update`. No sequence got cheaper with repetition.

## Where a small update's time goes (partial, p50 ms)

| subject | shape | total | createProgram | getTypeChecker | baseline | extraction | cp+tc share | ex share |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| drizzle-orm | leaf / contract / delete | 364 / 386 / 364 | 221 / 220 / 228 | 84 / 86 / 77 | 7 | 25 / 29 / 20 | 84 / 79 / 84% | 6–8% |
| immich | leaf / contract / delete | 2,009 / 1,814 / 1,444 | 1,439 / 1,377 / 1,025 | 336 / 307 / 322 | 19–20 | 44 / 64 / 27 | 88 / 93 / 93% | 2–4% |
| outline | leaf / contract / delete | 5,504 / 4,568 / 3,813 | 4,079 / 3,591 / 2,830 | 828 / 757 / 780 | 62–68 | 380 / 72 / 45 | 89 / 95 / 95% | 1–7% |

`summarize`, `impact`, `propagate` and `report` together: under 20 ms on
drizzle-orm, under 60 ms on immich and outline for these rows. On whole
rebuilds, extraction is 76–83% (immich), 69–74% (outline), 82–83% (drizzle-orm),
and cp+tc 15–31%.

**`createProgram` + `getTypeChecker` tracks program size** (quoted by the
other-inputs text, root text excluded): ≈ 0.3 s at 2.87 M chars (drizzle-orm), 1.3–1.8 s at 14.65 M (immich), 3.6–4.9 s at 45.19 M
(outline). That is the most Architecture C could remove from a small update;
the real saving is smaller (the changed file is still parsed, the checker still
merges globals), and it was not measured.

## `oldProgram`, with and without

`project-update` p25–p75, with / without. "No overlap" means the two IQRs do not
intersect.

| subject | shape | with | without | Δ total p50 (with − without) | IQRs |
|---|---|---|---|---:|---|
| drizzle-orm | leaf, hub, contract, add, delete, tsconfig | — | — | −68 … +81 | overlap on all six |
| drizzle-orm | five leaves / alternating (rerun) | 294–301 / 270–289 | 324–363 / 282–291 | −36 / −13 | no overlap / overlap |
| immich run 1 | leaf | 1,803–1,935 | 1,442–1,537 | +441 | no overlap |
| immich run 2 | leaf | 1,776–1,930 | 1,434–1,556 | +404 | no overlap |
| immich run 2 | ambit config | 1,629–1,744 | 1,316–1,406 | +278 | no overlap |
| immich | contract / outside-root / hub | 1,708–1,727 / 2,120–2,295 / 2,328–2,483 | 1,314–1,387 / 1,672–2,004 / 1,769–1,975 | +386 / +165 / −391 | no overlap |
| immich | same leaf ×10 / five leaves / alternating (rerun) | 1,652–1,748 / 1,940–2,024 / 1,610–1,678 | 1,408–1,538 / 1,480–1,593 / 1,260–1,305 | +219 / +476 / +357 | no overlap |
| immich | add file / delete file / tsconfig | 1,696–1,747 / 1,358–1,504 / 1,636–1,686 | 1,843–2,096 / 1,380–1,408 / 1,686–1,700 | −651 / −20 / +151 | no overlap / overlap / no overlap |
| outline | leaf / contract / hub / outside-root | 5,006–5,110 / 4,428–4,466 / 5,702–7,035 / 5,684–6,088 | 4,349–4,573 / 3,921–3,978 / 4,614–4,937 / 4,694–4,975 | +723 / +509 / +1,048 / +955 | no overlap |
| outline | delete file / tsconfig | 3,695–3,764 / 4,444–5,077 | 4,757–4,943 / 4,785–5,401 | −1,223 / +631 | no overlap / overlap |

- **Reproduced, and it survives a second independent run:** on immich the leaf
  edit's slowdown with `oldProgram` was +441 ms and +404 ms (phase 5: ≈ +700).
- **Consistent on both dependency-heavy subjects for edits that keep the file
  list and the options:** `project-update` is slower with `oldProgram` in every
  such row, IQRs apart — immich 9 of 9 (leaf ×2 runs, ambit config,
  contract-only, outside-root, hub, the three sequences), outline 4 of 4 (leaf,
  contract-only, hub, outside-root). hub's `total` goes the other way on immich
  because extraction, not `project-update`, dominates it.
- **The sign flips when the file list changes:** `oldProgram` is faster for
  immich's addition (−651 total) and outline's deletion (−1,223); immich's
  deletion is a tie. A tsconfig edit (options move, file list does not) is a
  tie on outline and 0–50 ms apart on immich.
- **drizzle-orm (no `node_modules`) shows no effect** outside one sequence row.

**Probe (throwaway, not committed):** the bench's own program construction
repeated outside Ambit — `ts.createProgram({ rootNames, options, oldProgram })`
after a leaf edit, reading the internal `program.structureIsReused` and
counting `SourceFile` objects shared with the previous program.

| program | with `oldProgram`: structure reuse | shared `SourceFile` objects | createProgram with / without (ms) |
|---|---|---:|---|
| immich, 3,207 files, 4 rounds × 2, then 2 × 2 | `Not` every round; 0 redirect files, 0 redirect targets | 0 | 1,332–1,702 / 908–1,157 |
| outline, 7,889 files, 2 rounds (the probe then ran out of heap holding two programs) | `Not` | 0 | 3,570–3,816 / — |
| a 67-file drizzle-orm subset (`sql-js/`, not the subject) | `Completely` | 0 | 64–92 / 64–74 |

On the two large programs, TypeScript abandons structure reuse on every leaf
edit and the default `CompilerHost` re-parses every file either way, so
`oldProgram` delivers no reuse and still costs ≈ 0.4–0.5 s (immich) of
`createProgram`. Package redirects — whose identity check an uncaching host can
never pass — are **not** the cause on immich: it has none. Which of
`tryReuseStructureFromOldProgram`'s other early returns fires, and why the sign
flips on file-list changes, was not probed. The probe process's V8 heap limit
is 4,288 MiB (Node's default here); holding two outline programs exceeded it.

## Peak RSS (MiB, per child process)

| subject | cold | resident (with or without `oldProgram`) |
|---|---|---|
| drizzle-orm | 1,244–2,010 | 1,376–2,724 |
| immich | 2,200–3,120 | 2,012–3,409 |
| outline | 2,727–2,898 | 3,163–3,786 |

## Top 3 expensive shapes (per update, resident, p50)

1. **Whole rebuilds on outline** — outside-root 20.3 s, hub 19.9 s, tsconfig
   19.8 s: slower than cold (16.3–17.7 s).
2. **Whole rebuilds and hub edits on immich** — 10.3–10.6 s, at or above cold.
3. **Small updates on outline** — leaf 5.5 s, contract-only 4.6 s, delete 3.8 s,
   89–95% of it `createProgram` + `getTypeChecker`.

Per update only. Which shape dominates a session depends on frequencies, which
this run did not measure; on this repository's own sessions whole rebuilds did
([2026-09-13](2026-09-13-resident-workload.md)).

## Decision

- **Architecture C: evidence insufficient.** The cost-side conditions hold on
  immich and outline: cp+tc is 88–95% of every small update and 1.3–4.9 s in
  absolute terms, so the upper bound is large, and `oldProgram` shows that
  compiler-side reuse without a caching host does not happen on these programs.
  The frequency condition does not: nothing here says leaf and contract-only
  updates are the common case on a 500+-file project, and whole rebuilds (at or
  above cold) are unaffected by C. No local project of that size has agent or
  editor logs to observe.
- **`oldProgram`: evidence insufficient.** Consistent within an update shape on
  both dependency-heavy subjects (slower with it when the file list holds,
  faster with it when a file is added or deleted), absent on drizzle-orm, and
  its mechanism is not identified.
- **Next investment: no optimization.** In the agent-loop reading (this
  repository's p50 gap between project-touching batches is 52 s) a 1.4–5.5 s
  small update and a 10–20 s rebuild are tolerable; in an editor reading,
  outline's 4–5.5 s per save is not, but no editor workload exists to size
  against. The input that would move either verdict is a measured session on a
  500+-file project — which, under the self-validation cap, has to come from an
  adopter rather than another repository chosen here.

## What is not measured

- How often any shape occurs on a 500+-file project. `docs/open-questions.md`'s
  reopen condition for Architecture C names a *measured editor session*; this run
  is not one and does not fire it.
- What Architecture C would actually save (only its bound above).
- Why structure reuse is `Not` on immich and outline, why `oldProgram` wins on
  file-list changes, and why a resident whole rebuild is slower than cold on
  outline.
- outline addition; outline sequences; Linux; any machine but this one.
- A deletion's correctness beyond the trivial one-function files the script
  creates (§6.2 makes a deletion a closure row; a deleted file that carried
  `declare global` or a `/// <reference path>` was not exercised here).
