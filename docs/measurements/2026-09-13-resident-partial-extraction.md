# The resident path's partial extraction, measured once

Run on 2026-09-13, Node.js v24.20.0, macOS (darwin arm64), Apple M1, 8 cores,
16 GiB, from this repository. `docs/status.md` carries the conclusion; this file
carries the run.

This is **not** phase 5's benchmark (`docs/resident-check-path.md`). It measures
one subject, one edit, three repetitions per verdict, with no baseline against
`analyze()` and no peak RSS. What it is for is narrower: phase 4 claims that a
partial update re-extracts a closure instead of a project, and a claim about
work not done has to be shown as work not done.

## The subject and the procedure

A copy of this repository's `src/` in a temporary directory, with a `tsconfig.json`
naming `include: ["**/*.ts"]` and no `node_modules` linked in — 49 source files,
412 extracted functions. A session is opened once; every row below is one
`update` on that session.

The edit is the same each time: one comment line inserted above
`export function impactClosure(` in `src/checker/impact.ts`. Its reverse-import
closure is 6 of the 49 files.

The two verdicts are produced by the *change set*, not by a flag:

- `reported` — `update([{ kind: "changed", path: "src/checker/impact.ts" }])`.
  The caller reports what moved, so the closure may be taken.
- `unreported` — `update()` with no argument at all. A caller that does not
  report changes gets a whole re-extraction, because a closure over nothing
  would answer from the previous tree.

`extraction` below is the reported `extraction` phase **minus** `projectUpdate`,
which the resident session reports separately and which the phase timing
includes.

## The numbers

All in milliseconds.

| verdict | re-extracted | project-update | extraction | impact | summarize | propagate | report | total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| reported | 6 / 49 | 162.5 | 67.3 | 1.74 | 0.63 | 0.36 | 1.74 | 234.3 |
| reported | 6 / 49 | 139.4 | 52.8 | 1.18 | 0.45 | 0.16 | 1.45 | 195.5 |
| reported | 6 / 49 | 142.4 | 49.6 | 0.93 | 0.43 | 0.17 | 7.76 | 201.3 |
| unreported | 49 / 49 | 128.3 | 196.2 | 1.15 | 2.25 | 0.15 | 1.00 | 329.1 |
| unreported | 49 / 49 | 140.1 | 188.6 | 1.17 | 2.61 | 0.18 | 1.32 | 334.0 |
| unreported | 49 / 49 | 134.0 | 198.4 | 1.46 | 2.43 | 0.19 | 1.66 | 338.2 |

The 7.76 ms `report` in row three is an outlier against six runs that are
otherwise 1.0–1.8 ms, and nothing here explains it; it is left in rather than
dropped, because six samples is not enough to call anything noise with
authority.

The impact set is 6 of 412 functions in every row — the same edit, so the
scoped fixed point does the same work whichever way extraction went.

## What it says

**Extraction shrank, which is what phase 4 was for.** 189–198 ms for the whole
project against 50–67 ms for a sixth of it. The two are the same code path with
a different `only` set, and the ratio tracks the file count rather than
beating it, which is what a per-file pass-2 restriction should do: pass 1 stays
whole-project by design, and it is inside both figures.

**`project-update` is now the dominant phase of a re-check, at 128–163 ms.**
That is `ts.createProgram` with `oldProgram` passed, plus `getTypeChecker()`,
plus the baseline the reuse gate compares (root names, resolved options, and the
program's non-implementation inputs). It did not fall when extraction did, and
on the partial rows it is about two thirds of the total.

The reuse gate's own cost is inside `project-update` and is not separated here.
On this subject it is close to free — the copy has no `node_modules`, so the
only program inputs the gate hashes are the compiler's own lib files, which are
excluded. On a tree with dependencies installed it is a text hash over every
`node_modules` typing the program read, and that is where it would show up.

Three things this **does not** say, and each matters:

- It is not a measurement of `oldProgram`'s value. No row here was run without
  it, so nothing separates "the program was reused" from "the program was
  rebuilt quickly". `docs/resident-check-path.md` already records why reuse is
  expected to be partial at best with the default `CompilerHost`; that remains
  unmeasured.
- It is not a comparison against `analyze()`. "Faster" is said against that
  baseline and against nothing else, and phase 5 is where the baseline is run.
- One subject, one edit, no repetition across trees. A dominant phase on 49
  files is not evidence about 5,000.

**It is, however, the condition ADR-0014 named for architecture C** — "a
measurement shows `project-update` or `extraction` dominating a cold start in a
resident session". The condition is met for `project-update` on one subject, and
one subject is not the case for C. What it does justify is where phase 5 should
point its instrument: at the program construction, not at the extraction that
phase 4 has already shrunk.

## Reproducing it

The script is not committed — it is thirty lines around `openResidentSession`,
and phase 5's `scripts/bench-resident.ts` is the thing that is meant to be kept.
What it did:

1. copy `src/` into a temporary directory with a `package.json` and the
   `tsconfig.json` above;
2. `openResidentSession(dir)`, and read `committed().store` for the file and
   function counts;
3. six times: insert one comment line into `src/checker/impact.ts`, call
   `update` with or without a change set, and print `result.timings`,
   `result.full`, `result.reextracted.length` and `result.impact`.
