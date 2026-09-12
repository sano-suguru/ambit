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
| reported | 6 / 49 | 158.0 | 78.9 | 1.77 | 0.59 | 0.30 | 1.60 | 241.2 |
| reported | 6 / 49 | 135.0 | 61.0 | 1.18 | 0.46 | 0.17 | 1.43 | 199.3 |
| reported | 6 / 49 | 141.8 | 50.1 | 0.97 | 0.44 | 0.17 | 1.09 | 194.6 |
| unreported | 49 / 49 | 139.8 | 198.3 | 1.14 | 2.21 | 0.15 | 0.99 | 342.6 |
| unreported | 49 / 49 | 135.2 | 193.5 | 1.01 | 2.44 | 0.17 | 1.25 | 333.5 |
| unreported | 49 / 49 | 135.4 | 171.5 | 1.09 | 2.10 | 0.17 | 1.18 | 311.5 |

The impact set is 6 of 412 functions in every row — the same edit, so the
scoped fixed point does the same work whichever way extraction went.

## What it says

**Extraction shrank, which is what phase 4 was for.** 172–198 ms for the whole
project against 50–79 ms for a sixth of it. The two are the same code path with
a different `only` set, and the ratio tracks the file count rather than
beating it, which is what a per-file pass-2 restriction should do: pass 1 stays
whole-project by design, and it is inside both figures.

**`project-update` is now the dominant phase of a re-check, at 135–158 ms.**
That is `ts.createProgram` with `oldProgram` passed, plus `getTypeChecker()`,
plus the baseline the reuse gate compares (root names, resolved options, and the
program's non-implementation inputs — 4.5 ms of the total, measured above). It did not fall when extraction did, and
on the partial rows it is about two thirds of the total.

The reuse gate's own cost is inside `project-update` and is not separated by the
phase timings. It was measured on its own instead: on this subject the gate
hashes **82 program inputs totalling 2.94 M characters — the compiler's own
`lib.*.d.ts` among them, because nothing is excluded by path — in 4.5 ms.**
That is about 3% of `project-update` and it does not show up in the table: an
earlier run of the same script with the default lib's directory excluded gave
`project-update` 128–163 ms against 135–158 ms here, which is the same number
inside run-to-run variation. On a tree with dependencies installed the hash
covers every `node_modules` typing the program read as well, and 2.94 M
characters is the floor rather than the figure.

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
