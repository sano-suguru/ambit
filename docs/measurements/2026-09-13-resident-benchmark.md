# The resident check path against `analyze()`, six subjects

Run on 2026-09-13, Node.js v24.20.0, TypeScript 6.0.3 (`typescript-legacy`),
macOS (darwin arm64), Apple M1, 8 cores, 16 GiB. Phase 5 of
[`docs/resident-check-path.md`](../resident-check-path.md). `docs/status.md`
carries the verdict; this file carries the run.

## Procedure

```sh
node scripts/bench-resident.ts --subjects ambit-src,realistic-api,got,trpc-server,drizzle-orm \
  --warmup 2 --iterations 7 --out main.json
node scripts/bench-resident.ts --immich <checkout> --subjects immich-server \
  --warmup 2 --iterations 5 --out immich.json
```

The immich checkout is the recipe in
[2026-09-11](2026-09-11-second-third-party-validation-immich.md)
(`immich-app/immich@2a626220`, `pnpm install --ignore-scripts --filter immich...`);
the script refuses any other `HEAD`. The corpus subjects are copies of the pinned
`.corpus/` subtrees; nothing under `.corpus/` or this repository is edited.

**Scenarios.** One child process per subject × mutation × scenario, so `maxRSS`
is that scenario's peak:

| scenario | what runs each iteration |
|---|---|
| `cold` | `analyze()` on the mutated tree — the baseline |
| `full` | `session.update()` with no change set: whole re-extraction on a held program |
| `partial` | `session.update(changes)`; whether it *was* partial is the session's verdict |
| `full-noold`, `partial-noold` | the same with `oldProgram` withheld (`openProjectForMeasurement`, a measurement-only seam) |

Two unmeasured warmup iterations, then 7 measured (5 on immich). Every iteration
applies a new variant of the mutation, so every measured update processes a real
change. Tables quote the median; the raw table below adds min–max, and the JSON
the script writes carries p25/p75 for every column.

**Mutations**, chosen by the script from the first generation's store:

| mutation | edit | change set passed to `partial` |
|---|---|---|
| leaf | append an exported function to the median-sized file with no importers. After the warmup, variants differ only in the returned literal, so the summary does not move and S = I = 0: the row measures re-extraction and the reuse gate, not propagation | `changed` |
| hub | the same, to the file with the widest reverse-import closure | `changed` |
| jsdoc | toggle `/** @effects fs_read */` ↔ `fs_write` above an undocumented function that has callers, in the widest-closure file that has one; verified to attach | `changed` |
| config | toggle an unused effect alias in a created `ambit.config.ts` (a toggled trailing comment in realistic-api's existing one) | `changed` if the config is a store file, else `[]` |
| addition | add a new one-function file | `added` — full by §6.2 |
| tsconfig | toggle `customConditions` (a module-resolution option nothing reads) | `[]` — full by §6.2 |

**Subjects.**

| subject | files / functions | external program inputs | hub closure |
|---|---:|---:|---:|
| realistic-api | 19 / 57 | 69 files, 0.52 M chars | 7 |
| got (corpus, small) | 25 / 358 | 63 files, 2.87 M chars | 14 |
| ambit-src (`src/` with its real tsconfig, `test/` and `node_modules`) | 49 / 414 | 640 files, 6.82 M chars | 39 |
| trpc-server (corpus, medium) | 83 / 197 | 63 files, 2.87 M chars | 61 |
| drizzle-orm (corpus, large) | 448 / 2,652 | 63 files, 2.87 M chars | 432 |
| immich `server/src`, dependencies installed | 557 / 3,192 | 2,679 files, 14.65 M chars | 427 |

The corpus subjects have no dependencies installed by design, so their external
inputs are the compiler's `lib.*.d.ts` alone. ambit-src and immich are the two
with `node_modules` in the program.

## Equivalence

Every resident scenario ended by comparing its last answer, rendered with
`test/support/renderAnalysis`, against a fresh cold `analyze()` of the same tree:
**144 of 144 equal** (6 subjects × 6 mutations × 4 resident scenarios). No correctness defect was found.

## Cold, full and partial (median ms)

| subject | mutation | cold | full | partial | partial verdict | re-extracted | S | I |
|---|---|---:|---:|---:|---|---:|---:|---:|
| realistic-api | leaf | 48 | 47 | 37 | partial | 1/19 | 0 | 0/57 |
| realistic-api | jsdoc | 52 | 57 | 50 | partial | 6/19 | 1 | 3/56 |
| got | leaf | 274 | 269 | 148 | partial | 1/25 | 0 | 0/358 |
| got | jsdoc | 310 | 286 | 276 | partial | 14/25 | 1 | 16/357 |
| ambit-src | leaf | 739 | 640 | 438 | partial | 1/49 | 0 | 0/414 |
| ambit-src | jsdoc | 664 | 648 | 634 | partial | 39/49 | 1 | 16/413 |
| trpc-server | leaf | 321 | 301 | 144 | partial | 1/83 | 0 | 0/197 |
| trpc-server | jsdoc | 331 | 309 | 286 | partial | 61/83 | 1 | 19/196 |
| drizzle-orm | leaf | 1,947 | 1,962 | **331** | partial | 1/448 | 0 | 0/2,652 |
| drizzle-orm | hub | 1,969 | 1,977 | 1,942 | partial | 432/448 | 0 | 0/2,652 |
| drizzle-orm | jsdoc | 1,916 | 1,945 | 1,956 | partial | 432/448 | 1 | 720/2,651 |
| drizzle-orm | config | 2,046 | 1,903 | **331** | partial | 1/449 | 0 | 0/2,651 |
| drizzle-orm | addition | 1,985 | 1,970 | 1,952 | full | 451/451 | 1 | 1/2,654 |
| drizzle-orm | tsconfig | 2,037 | 1,958 | 2,098 | full | 448/448 | 0 | 0/2,651 |
| immich | leaf | 10,361 | 11,582 | **2,200** | partial | 1/557 | 0 | 0/3,192 |
| immich | hub | 9,813 | 10,518 | 10,479 | partial | 427/557 | 0 | 0/3,192 |
| immich | jsdoc | 9,740 | 10,425 | 10,187 | partial | 419/557 | 1 | 2/3,191 |
| immich | config | 9,910 | 10,280 | **1,951** | partial | 0/557 | 0 | 0/3,191 |
| immich | addition | 10,064 | 9,899 | 10,008 | full | 560/560 | 1 | 1/3,194 |
| immich | tsconfig | 12,059 | 10,602 | 10,831 | full | 557/557 | 0 | 0/3,191 |

The leaf edit on ambit-src had one 1,365 ms outlier in `cold`; its other five
mutations put cold at 659–704 ms. The remaining rows for the small subjects are
in the raw table.

## Where a re-check's time goes

Median ms. `pu` is `project-update`; `cp` createProgram, `tc` getTypeChecker,
`bl` the reuse gate's baseline (external-input hashing included); `ex` is the
extraction walk (`extraction − project-update`).

| subject | mutation · scenario | total | pu | cp | tc | bl | ex | cp+tc share |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| realistic-api | leaf · partial | 37 | 32 | 20 | 7 | 0.6 | 3 | 72% |
| got | leaf · partial | 148 | 141 | 100 | 38 | 4.7 | 5 | 93% |
| trpc-server | leaf · partial | 144 | 137 | 99 | 32 | 4.7 | 6 | 91% |
| ambit-src | leaf · partial | 438 | 429 | 309 | 112 | 7.1 | 7 | 96% |
| drizzle-orm | leaf · partial | 331 | 293 | 204 | 76 | 6.1 | 20 | 85% |
| immich | leaf · partial | 2,200 | 2,114 | 1,465 | 337 | 22.4 | 29 | 82% |
| immich | leaf · partial-noold | 1,496 | 1,427 | 1,103 | 300 | 20.5 | 29 | 94% |
| ambit-src | jsdoc · partial | 634 | 425 | 310 | 106 | 7.1 | 207 | 66% |
| drizzle-orm | jsdoc · partial | 1,956 | 286 | 196 | 76 | 6.1 | 1,630 | 14% |
| immich | jsdoc · partial | 10,187 | 2,173 | 1,601 | 526 | 19.8 | 7,916 | 21% |
| drizzle-orm | tsconfig · partial (full) | 2,098 | 337 | 241 | 82 | 6.8 | 1,687 | 15% |
| immich | tsconfig · partial (full) | 10,831 | 1,780 | 1,431 | 323 | 20.6 | 8,804 | 16% |

`impact`, `summarize`, `propagate` and `report` together are under 10 ms on
every subject below 100 files, under 25 ms on drizzle-orm, and on immich
`summarize` is 84–126 ms on a whole re-summarization and `report` about 20 ms.

**External-input hashing** (`bl`) is 0.6 ms (69 files, 0.52 M chars), 4.4–4.9 ms
(63 files, 2.87 M), 7.1–7.3 ms (640 files, 6.82 M, ambit-src with
`node_modules`) and 20–22 ms (2,679 files, 14.65 M, immich). Its p25–p75 spread is
under 1 ms on every subject except immich's `partial` (20.5–23.2). It is at most
2% of `project-update` on any subject.

## `oldProgram`, with and without

Median `project-update`, ms, same mutation:

| subject | leaf partial: with / without | config partial | hub partial | full re-extraction (leaf) |
|---|---|---|---|---|
| realistic-api | 32 / 30 | 29 / 32 | 31 / 37 | 32 / 31 |
| got | 141 / 144 | 132 / 137 | 142 / 134 | 128 / 133 |
| trpc-server | 137 / 147 | 142 / 138 | 146 / 150 | 135 / 138 |
| ambit-src | 429 / 439 | 442 / 442 | 443 / 456 | 429 / 438 |
| drizzle-orm | 293 / 314 | 287 / 301 | 292 / 321 | 289 / 306 |
| immich | **2,114 / 1,427** | **1,796 / 1,287** | **2,271 / 1,748** | **2,643 / 2,047** |

On the five subjects without installed dependencies, withholding `oldProgram`
moves `project-update` by −3 to +29 ms, inside the p25–p75 spread of most rows:
**no measurable saving.** On immich, passing it is **slower** by 280–690 ms in
every row where the root names and options are unchanged, and equal (within
noise) on addition and tsconfig, where `tryReuseStructureFromOldProgram` bails.
Whether the compiler reported any structure reuse is not read:
`Program.structureIsReused` is `@internal`. The cause of immich's extra cost is
not isolated here.

## Peak RSS (MiB, `maxRSS` of the scenario's process)

| subject | cold | resident scenarios |
|---|---:|---:|
| realistic-api | 333–378 | 336–400 |
| got | 627–902 | 727–975 |
| trpc-server | 620–720 | 719–945 |
| ambit-src | 1,113–1,927 | 1,418–1,876 |
| drizzle-orm | 1,383–1,788 | 1,723–2,401 |
| immich | 2,511–2,930 | 2,484–3,920 |

A resident process holds one program, the store and the previous generation's
program while the next is built; its peak is 0–1,000 MiB above the cold
process's.

## What it says, and what it does not

- **Where partial extraction applies, it is the win:** a leaf or config edit is
  1.3× (realistic-api) to 5.9× (drizzle-orm) faster than `analyze()`, and 4.7×
  on immich. Every one of those rows is 82–96% createProgram + getTypeChecker.
- **Where the reverse-import closure is wide, partial equals full.** The hub and
  JSDoc edits on drizzle-orm and immich re-extracted 419–432 files, and
  extraction is 77–85% of their total. The JSDoc row is §6.2's headline case —
  a contract comment rewritten — and it is the slowest kind of re-check on both
  large subjects.
- **Additions and tsconfig edits are full rebuilds by design** and cost what
  `analyze()` costs, extraction-dominated on the large subjects.
- **`oldProgram` buys nothing measurable** with the default `CompilerHost`, and
  costs about 0.5–0.7 s on immich.
- External-input hashing is not a cost worth narrowing on any subject measured,
  including 2,679 `node_modules` inputs.
- `cold` has no phase breakdown of its own; `full-noold` — a whole re-extraction
  on a program built without reuse — is the proxy used for it.

It does **not** measure how often each mutation happens in a real editor
session, a warm-cache compiler host, Linux, or any subject with more than 560
files.

## Raw results

Median [min–max] for `total`, medians for the phases, first measured run for the
counts.

| subject | mutation | scenario | total p50 [min–max] | project-update | createProgram | typeChecker | baseline | extraction | summarize | impact | propagate | report | unattributed | verdict | re-extracted | S | I | peak RSS MiB | = cold |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---|
| ambit-src | leaf | cold | 739.3 [634.6–1365.1] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1122 | — |
| ambit-src | leaf | full | 639.9 [622.7–956.3] | 429.4 | 311.4 | 108.3 | 7.3 | 211.7 | 2.3 | 1.1 | 0.1 | 1.3 | 0.5 | full | 49/49 | 0 | 0/414 | 1471 | true |
| ambit-src | leaf | partial | 438.4 [428.4–509.2] | 429.3 | 308.9 | 112.1 | 7.1 | 6.7 | 0.1 | 0.6 | 0.1 | 1.3 | 0.4 | partial | 1/49 | 0 | 0/414 | 1511 | true |
| ambit-src | leaf | full-noold | 651.4 [630.3–674.8] | 438.2 | 316.9 | 108.8 | 7.3 | 208.5 | 2.1 | 1.1 | 0.1 | 1.3 | 0.5 | full | 49/49 | 0 | 0/414 | 1489 | true |
| ambit-src | leaf | partial-noold | 448.3 [438.3–470.8] | 438.6 | 322.0 | 107.2 | 7.2 | 6.9 | 0.1 | 0.7 | 0.1 | 1.2 | 0.4 | partial | 1/49 | 0 | 0/414 | 1426 | true |
| ambit-src | hub | cold | 679.6 [657.7–733.7] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1113 | — |
| ambit-src | hub | full | 674.2 [647.2–775.1] | 435.2 | 316.1 | 112.1 | 7.6 | 238.7 | 2.7 | 1.2 | 0.1 | 1.4 | 0.6 | full | 49/49 | 0 | 0/414 | 1791 | true |
| ambit-src | hub | partial | 653.4 [617.4–680.8] | 443.1 | 326.0 | 109.2 | 7.3 | 208.2 | 2.0 | 1.0 | 0.1 | 1.3 | 0.5 | partial | 39/49 | 0 | 0/414 | 1533 | true |
| ambit-src | hub | full-noold | 663.3 [628.7–741.9] | 444.7 | 319.2 | 111.3 | 7.3 | 213.3 | 2.2 | 1.1 | 0.1 | 1.3 | 0.5 | full | 49/49 | 0 | 0/414 | 1781 | true |
| ambit-src | hub | partial-noold | 668.9 [648.7–814.5] | 455.8 | 329.7 | 109.5 | 7.4 | 212.7 | 2.1 | 1.2 | 0.1 | 1.3 | 0.5 | partial | 39/49 | 0 | 0/414 | 1804 | true |
| ambit-src | jsdoc | cold | 663.8 [640.8–711.5] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1927 | — |
| ambit-src | jsdoc | full | 647.8 [631.3–755.5] | 424.9 | 311.1 | 106.7 | 7.1 | 217.4 | 2.2 | 1.2 | 0.3 | 1.5 | 0.5 | full | 49/49 | 1 | 16/413 | 1477 | true |
| ambit-src | jsdoc | partial | 634.0 [621.8–690.9] | 424.6 | 310.3 | 105.7 | 7.1 | 206.5 | 2.5 | 1.1 | 0.3 | 1.4 | 0.5 | partial | 39/49 | 1 | 16/413 | 1801 | true |
| ambit-src | jsdoc | full-noold | 653.5 [636.4–709.1] | 440.2 | 320.5 | 107.8 | 7.3 | 206.7 | 2.1 | 1.1 | 0.3 | 1.4 | 0.5 | full | 49/49 | 1 | 16/413 | 1794 | true |
| ambit-src | jsdoc | partial-noold | 654.1 [632.7–682.3] | 439.7 | 320.5 | 106.9 | 7.4 | 208.3 | 2.5 | 1.2 | 0.3 | 1.5 | 0.5 | partial | 39/49 | 1 | 16/413 | 1467 | true |
| ambit-src | config | cold | 703.9 [638.3–745.2] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1212 | — |
| ambit-src | config | full | 653.4 [629.9–691.4] | 431.4 | 310.0 | 110.5 | 7.2 | 217.4 | 2.5 | 1.1 | 0.1 | 1.2 | 0.8 | full | 49/49 | 0 | 0/413 | 1840 | true |
| ambit-src | config | partial | 450.1 [433.7–524.3] | 442.4 | 318.4 | 112.2 | 7.2 | 2.9 | 2.4 | 0.6 | 0.1 | 1.3 | 0.7 | partial | 0/49 | 0 | 0/413 | 1764 | true |
| ambit-src | config | full-noold | 664.3 [640.0–693.1] | 445.6 | 324.8 | 109.3 | 7.4 | 212.9 | 2.5 | 1.2 | 0.1 | 1.3 | 0.7 | full | 49/49 | 0 | 0/413 | 1834 | true |
| ambit-src | config | partial-noold | 450.7 [445.9–484.9] | 441.6 | 325.9 | 107.2 | 7.3 | 3.0 | 2.2 | 0.6 | 0.1 | 1.4 | 0.7 | partial | 0/49 | 0 | 0/413 | 1418 | true |
| ambit-src | addition | cold | 665.8 [636.5–725.3] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1240 | — |
| ambit-src | addition | full | 653.1 [638.1–688.8] | 440.1 | 319.5 | 106.3 | 7.3 | 209.9 | 2.3 | 1.1 | 0.1 | 1.3 | 0.5 | full | 52/52 | 1 | 1/416 | 1796 | true |
| ambit-src | addition | partial | 718.8 [664.8–728.2] | 475.6 | 345.3 | 111.5 | 7.4 | 226.7 | 2.3 | 1.1 | 0.1 | 1.4 | 0.5 | full | 52/52 | 1 | 1/416 | 1783 | true |
| ambit-src | addition | full-noold | 669.4 [650.2–712.3] | 442.2 | 322.4 | 109.4 | 7.3 | 220.1 | 2.5 | 1.2 | 0.1 | 1.4 | 0.5 | full | 52/52 | 1 | 1/416 | 1494 | true |
| ambit-src | addition | partial-noold | 667.4 [645.0–704.0] | 451.5 | 330.6 | 113.8 | 7.5 | 215.0 | 2.6 | 1.1 | 0.1 | 1.2 | 0.5 | full | 52/52 | 1 | 1/416 | 1876 | true |
| ambit-src | tsconfig | cold | 658.9 [638.9–735.3] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1204 | — |
| ambit-src | tsconfig | full | 656.3 [637.9–900.9] | 447.7 | 325.7 | 111.2 | 7.3 | 214.3 | 2.3 | 1.2 | 0.1 | 1.4 | 0.7 | full | 49/49 | 0 | 0/413 | 1479 | true |
| ambit-src | tsconfig | partial | 701.5 [650.4–776.8] | 466.6 | 337.6 | 118.0 | 7.7 | 216.7 | 2.3 | 1.3 | 0.1 | 1.2 | 0.7 | full | 49/49 | 0 | 0/413 | 1869 | true |
| ambit-src | tsconfig | full-noold | 657.5 [641.2–805.5] | 440.6 | 318.2 | 113.6 | 7.4 | 211.7 | 2.1 | 1.1 | 0.1 | 1.4 | 0.7 | full | 49/49 | 0 | 0/413 | 1511 | true |
| ambit-src | tsconfig | partial-noold | 645.7 [620.3–701.7] | 436.3 | 313.0 | 107.9 | 7.3 | 208.8 | 2.2 | 1.2 | 0.1 | 1.4 | 0.7 | full | 49/49 | 0 | 0/413 | 1540 | true |
| realistic-api | leaf | cold | 48.3 [41.0–52.7] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 364 | — |
| realistic-api | leaf | full | 46.8 [38.0–61.4] | 32.0 | 23.4 | 6.8 | 0.6 | 14.4 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/57 | 398 | true |
| realistic-api | leaf | partial | 36.5 [28.7–45.2] | 32.3 | 19.7 | 6.9 | 0.6 | 3.1 | 0.1 | 0.2 | 0.0 | 0.3 | 0.4 | partial | 1/19 | 0 | 0/57 | 364 | true |
| realistic-api | leaf | full-noold | 46.4 [38.3–51.9] | 31.0 | 22.3 | 6.4 | 0.6 | 12.3 | 0.3 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/57 | 396 | true |
| realistic-api | leaf | partial-noold | 33.5 [30.7–49.5] | 29.5 | 21.3 | 6.6 | 0.6 | 3.0 | 0.1 | 0.2 | 0.0 | 0.3 | 0.4 | partial | 1/19 | 0 | 0/57 | 345 | true |
| realistic-api | hub | cold | 49.9 [41.3–56.2] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 333 | — |
| realistic-api | hub | full | 45.9 [37.5–52.0] | 31.3 | 20.0 | 6.5 | 0.6 | 12.5 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/57 | 356 | true |
| realistic-api | hub | partial | 41.2 [34.0–49.4] | 31.2 | 23.7 | 6.3 | 0.6 | 7.7 | 0.2 | 0.2 | 0.0 | 0.3 | 0.4 | partial | 7/19 | 0 | 0/57 | 366 | true |
| realistic-api | hub | full-noold | 45.5 [39.1–55.4] | 30.1 | 22.1 | 6.8 | 0.6 | 12.7 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/57 | 374 | true |
| realistic-api | hub | partial-noold | 49.6 [43.1–56.1] | 37.2 | 25.2 | 7.4 | 0.7 | 11.2 | 0.2 | 0.2 | 0.0 | 0.3 | 0.5 | partial | 7/19 | 0 | 0/57 | 383 | true |
| realistic-api | jsdoc | cold | 52.2 [46.1–60.7] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 334 | — |
| realistic-api | jsdoc | full | 56.6 [44.2–71.3] | 37.4 | 24.3 | 7.7 | 0.6 | 14.9 | 0.4 | 0.2 | 0.0 | 0.3 | 0.5 | full | 19/19 | 1 | 3/56 | 397 | true |
| realistic-api | jsdoc | partial | 50.3 [40.0–56.9] | 36.8 | 28.5 | 7.9 | 0.7 | 9.3 | 0.3 | 0.2 | 0.0 | 0.4 | 0.5 | partial | 6/19 | 1 | 3/56 | 358 | true |
| realistic-api | jsdoc | full-noold | 46.9 [40.2–64.0] | 33.6 | 24.3 | 7.1 | 0.6 | 12.5 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 1 | 3/56 | 370 | true |
| realistic-api | jsdoc | partial-noold | 41.7 [34.1–47.7] | 29.3 | 20.9 | 7.0 | 0.6 | 7.3 | 0.2 | 0.2 | 0.0 | 0.3 | 0.4 | partial | 6/19 | 1 | 3/56 | 358 | true |
| realistic-api | config | cold | 47.2 [39.4–53.1] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 363 | — |
| realistic-api | config | full | 45.2 [40.3–47.3] | 31.4 | 23.7 | 6.6 | 0.6 | 12.9 | 0.3 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/56 | 400 | true |
| realistic-api | config | partial | 30.5 [27.1–39.7] | 28.6 | 20.4 | 6.9 | 0.6 | 0.5 | 0.4 | 0.1 | 0.0 | 0.3 | 0.4 | partial | 1/19 | 0 | 0/56 | 358 | true |
| realistic-api | config | full-noold | 47.1 [41.1–55.8] | 34.8 | 24.5 | 6.9 | 0.6 | 13.2 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/56 | 369 | true |
| realistic-api | config | partial-noold | 34.1 [28.6–37.5] | 32.3 | 21.4 | 6.9 | 0.6 | 0.5 | 0.3 | 0.1 | 0.0 | 0.3 | 0.4 | partial | 1/19 | 0 | 0/56 | 336 | true |
| realistic-api | addition | cold | 48.1 [42.5–53.9] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 378 | — |
| realistic-api | addition | full | 49.7 [39.8–54.5] | 36.0 | 26.6 | 6.8 | 0.6 | 13.4 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 22/22 | 1 | 1/59 | 369 | true |
| realistic-api | addition | partial | 47.3 [39.4–56.0] | 32.6 | 24.3 | 6.8 | 0.6 | 12.6 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 22/22 | 1 | 1/59 | 368 | true |
| realistic-api | addition | full-noold | 47.0 [40.5–54.6] | 33.6 | 25.6 | 6.9 | 0.6 | 12.6 | 0.3 | 0.2 | 0.0 | 0.3 | 0.4 | full | 22/22 | 1 | 1/59 | 369 | true |
| realistic-api | addition | partial-noold | 52.6 [45.1–65.4] | 35.5 | 25.9 | 7.3 | 0.6 | 14.9 | 0.5 | 0.2 | 0.0 | 0.3 | 0.5 | full | 22/22 | 1 | 1/59 | 363 | true |
| realistic-api | tsconfig | cold | 50.4 [43.9–129.9] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 333 | — |
| realistic-api | tsconfig | full | 46.7 [39.7–52.9] | 33.1 | 24.5 | 6.8 | 0.6 | 12.5 | 0.4 | 0.2 | 0.0 | 0.3 | 0.4 | full | 19/19 | 0 | 0/56 | 369 | true |
| realistic-api | tsconfig | partial | 51.1 [44.6–55.3] | 37.3 | 25.1 | 7.0 | 0.6 | 13.6 | 0.4 | 0.2 | 0.0 | 0.3 | 0.5 | full | 19/19 | 0 | 0/56 | 368 | true |
| realistic-api | tsconfig | full-noold | 60.0 [44.4–92.9] | 41.0 | 29.3 | 8.2 | 0.6 | 17.0 | 0.5 | 0.2 | 0.0 | 0.3 | 0.5 | full | 19/19 | 0 | 0/56 | 369 | true |
| realistic-api | tsconfig | partial-noold | 58.9 [49.5–89.5] | 39.2 | 27.8 | 7.9 | 0.6 | 15.1 | 0.5 | 0.2 | 0.0 | 0.3 | 0.7 | full | 19/19 | 0 | 0/56 | 368 | true |
| got | leaf | cold | 274.3 [260.4–313.2] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 902 | — |
| got | leaf | full | 269.0 [265.1–300.9] | 127.6 | 84.0 | 32.2 | 4.4 | 142.6 | 1.6 | 1.0 | 0.1 | 1.0 | 0.3 | full | 25/25 | 0 | 0/358 | 849 | true |
| got | leaf | partial | 147.5 [140.5–168.8] | 141.0 | 100.3 | 37.6 | 4.7 | 5.0 | 0.1 | 0.5 | 0.1 | 1.0 | 0.3 | partial | 1/25 | 0 | 0/358 | 771 | true |
| got | leaf | full-noold | 320.2 [298.6–363.1] | 132.6 | 94.7 | 38.6 | 4.4 | 177.7 | 1.8 | 1.1 | 0.1 | 1.1 | 0.3 | full | 25/25 | 0 | 0/358 | 781 | true |
| got | leaf | partial-noold | 151.2 [137.9–168.3] | 143.6 | 102.6 | 33.0 | 4.5 | 4.6 | 0.1 | 0.6 | 0.1 | 1.0 | 0.3 | partial | 1/25 | 0 | 0/358 | 727 | true |
| got | hub | cold | 393.8 [352.8–644.6] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 647 | — |
| got | hub | full | 329.9 [321.2–355.7] | 143.8 | 99.1 | 41.4 | 4.8 | 181.2 | 1.7 | 1.1 | 0.1 | 1.1 | 0.3 | full | 25/25 | 0 | 0/358 | 845 | true |
| got | hub | partial | 309.6 [286.5–357.9] | 141.7 | 96.4 | 35.6 | 4.7 | 164.0 | 1.7 | 1.1 | 0.1 | 1.1 | 0.4 | partial | 14/25 | 0 | 0/358 | 842 | true |
| got | hub | full-noold | 291.7 [281.1–310.2] | 135.5 | 92.4 | 32.3 | 4.5 | 155.1 | 1.7 | 1.1 | 0.1 | 1.1 | 0.3 | full | 25/25 | 0 | 0/358 | 775 | true |
| got | hub | partial-noold | 278.5 [267.5–304.1] | 134.0 | 92.1 | 33.5 | 4.7 | 142.2 | 1.5 | 0.9 | 0.1 | 1.1 | 0.4 | partial | 14/25 | 0 | 0/358 | 925 | true |
| got | jsdoc | cold | 310.1 [288.2–376.5] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 627 | — |
| got | jsdoc | full | 285.8 [269.8–321.9] | 129.6 | 87.8 | 37.2 | 4.5 | 150.0 | 1.6 | 1.0 | 0.5 | 1.2 | 0.3 | full | 25/25 | 1 | 16/357 | 847 | true |
| got | jsdoc | partial | 276.1 [268.8–327.8] | 132.6 | 90.4 | 32.5 | 4.5 | 139.9 | 1.6 | 1.0 | 0.5 | 1.1 | 0.3 | partial | 14/25 | 1 | 16/357 | 900 | true |
| got | jsdoc | full-noold | 287.7 [281.5–320.0] | 132.4 | 93.3 | 36.0 | 4.4 | 149.2 | 1.7 | 1.0 | 0.5 | 1.1 | 0.3 | full | 25/25 | 1 | 16/357 | 781 | true |
| got | jsdoc | partial-noold | 283.9 [262.9–291.3] | 130.5 | 90.5 | 37.7 | 4.5 | 141.7 | 1.5 | 1.0 | 0.5 | 1.0 | 0.3 | partial | 14/25 | 1 | 16/357 | 975 | true |
| got | config | cold | 290.3 [283.0–329.4] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 689 | — |
| got | config | full | 291.1 [273.1–367.1] | 128.7 | 89.6 | 34.4 | 4.7 | 156.6 | 1.5 | 1.1 | 0.1 | 1.1 | 0.7 | full | 26/26 | 0 | 0/357 | 949 | true |
| got | config | partial | 142.0 [130.7–149.6] | 132.0 | 93.8 | 32.0 | 4.5 | 2.1 | 1.3 | 0.5 | 0.1 | 1.0 | 0.7 | partial | 1/26 | 0 | 0/357 | 866 | true |
| got | config | full-noold | 288.9 [283.3–310.5] | 129.2 | 90.0 | 31.5 | 4.6 | 156.6 | 1.5 | 1.0 | 0.1 | 1.1 | 0.7 | full | 26/26 | 0 | 0/357 | 904 | true |
| got | config | partial-noold | 143.2 [133.2–159.7] | 136.7 | 94.6 | 32.4 | 4.4 | 2.4 | 1.6 | 0.6 | 0.1 | 1.1 | 0.7 | partial | 1/26 | 0 | 0/357 | 737 | true |
| got | addition | cold | 299.9 [273.0–352.3] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 742 | — |
| got | addition | full | 290.8 [276.6–368.9] | 134.6 | 90.9 | 38.1 | 4.8 | 157.5 | 1.6 | 1.0 | 0.1 | 1.0 | 0.3 | full | 28/28 | 1 | 1/360 | 919 | true |
| got | addition | partial | 294.3 [279.1–321.5] | 133.5 | 94.6 | 32.5 | 4.4 | 151.0 | 1.8 | 1.0 | 0.1 | 1.0 | 0.3 | full | 28/28 | 1 | 1/360 | 778 | true |
| got | addition | full-noold | 299.9 [282.0–373.1] | 130.0 | 92.2 | 32.9 | 4.6 | 152.1 | 1.9 | 1.0 | 0.1 | 1.0 | 0.3 | full | 28/28 | 1 | 1/360 | 768 | true |
| got | addition | partial-noold | 283.4 [279.8–314.9] | 133.3 | 91.7 | 32.6 | 4.5 | 152.1 | 1.6 | 1.0 | 0.1 | 1.1 | 0.3 | full | 28/28 | 1 | 1/360 | 844 | true |
| got | tsconfig | cold | 294.0 [272.4–312.0] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 699 | — |
| got | tsconfig | full | 297.6 [282.7–312.5] | 133.0 | 93.9 | 33.9 | 4.4 | 161.2 | 1.7 | 1.0 | 0.1 | 1.1 | 0.5 | full | 25/25 | 0 | 0/357 | 856 | true |
| got | tsconfig | partial | 287.3 [275.0–320.5] | 130.3 | 89.1 | 37.8 | 4.4 | 154.6 | 1.6 | 1.0 | 0.1 | 1.0 | 0.5 | full | 25/25 | 0 | 0/357 | 786 | true |
| got | tsconfig | full-noold | 290.7 [273.6–309.6] | 128.7 | 92.5 | 31.5 | 4.4 | 148.5 | 1.6 | 1.0 | 0.1 | 1.1 | 0.6 | full | 25/25 | 0 | 0/357 | 784 | true |
| got | tsconfig | partial-noold | 282.1 [275.3–324.7] | 128.6 | 89.0 | 37.8 | 4.7 | 151.6 | 1.7 | 1.0 | 0.1 | 1.0 | 0.5 | full | 25/25 | 0 | 0/357 | 786 | true |
| trpc-server | leaf | cold | 321.4 [297.2–400.9] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 647 | — |
| trpc-server | leaf | full | 301.0 [290.4–313.7] | 134.6 | 90.1 | 37.5 | 4.7 | 164.1 | 0.9 | 0.7 | 0.1 | 0.8 | 0.4 | full | 83/83 | 0 | 0/197 | 893 | true |
| trpc-server | leaf | partial | 143.7 [137.0–160.1] | 136.7 | 99.0 | 32.3 | 4.7 | 5.9 | 0.1 | 0.4 | 0.1 | 0.7 | 0.4 | partial | 1/83 | 0 | 0/197 | 719 | true |
| trpc-server | leaf | full-noold | 304.9 [293.6–321.9] | 137.6 | 97.2 | 31.6 | 4.7 | 171.2 | 0.7 | 0.7 | 0.1 | 0.7 | 0.4 | full | 83/83 | 0 | 0/197 | 883 | true |
| trpc-server | leaf | partial-noold | 157.8 [137.6–164.1] | 147.0 | 107.0 | 33.6 | 4.8 | 6.5 | 0.1 | 0.4 | 0.0 | 0.8 | 0.4 | partial | 1/83 | 0 | 0/197 | 898 | true |
| trpc-server | hub | cold | 328.2 [293.4–361.3] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 720 | — |
| trpc-server | hub | full | 349.9 [307.1–398.3] | 148.0 | 103.8 | 33.6 | 4.9 | 201.9 | 1.0 | 0.8 | 0.1 | 0.9 | 0.4 | full | 83/83 | 0 | 0/197 | 883 | true |
| trpc-server | hub | partial | 295.2 [278.8–541.4] | 145.7 | 95.5 | 41.5 | 5.1 | 150.3 | 0.7 | 0.7 | 0.0 | 0.8 | 0.5 | partial | 61/83 | 0 | 0/197 | 881 | true |
| trpc-server | hub | full-noold | 303.7 [285.2–357.2] | 138.9 | 95.9 | 36.1 | 4.6 | 163.1 | 0.8 | 0.6 | 0.1 | 0.8 | 0.4 | full | 83/83 | 0 | 0/197 | 827 | true |
| trpc-server | hub | partial-noold | 323.0 [275.7–355.4] | 149.7 | 100.1 | 33.4 | 5.0 | 158.1 | 0.7 | 0.6 | 0.1 | 0.7 | 0.5 | partial | 61/83 | 0 | 0/197 | 798 | true |
| trpc-server | jsdoc | cold | 330.5 [300.4–353.4] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 678 | — |
| trpc-server | jsdoc | full | 308.9 [283.1–321.9] | 137.6 | 93.4 | 37.1 | 4.7 | 162.5 | 0.8 | 0.8 | 0.2 | 0.8 | 0.4 | full | 83/83 | 1 | 19/196 | 826 | true |
| trpc-server | jsdoc | partial | 286.0 [276.4–303.0] | 135.3 | 97.2 | 31.4 | 4.9 | 146.7 | 0.8 | 0.6 | 0.2 | 0.8 | 0.4 | partial | 61/83 | 1 | 19/196 | 945 | true |
| trpc-server | jsdoc | full-noold | 312.9 [287.8–329.9] | 139.3 | 97.0 | 36.2 | 4.7 | 170.6 | 0.8 | 0.7 | 0.2 | 0.8 | 0.4 | full | 83/83 | 1 | 19/196 | 814 | true |
| trpc-server | jsdoc | partial-noold | 288.0 [270.6–315.0] | 136.7 | 97.9 | 30.6 | 4.6 | 144.7 | 0.7 | 0.6 | 0.2 | 0.7 | 0.4 | partial | 61/83 | 1 | 19/196 | 875 | true |
| trpc-server | config | cold | 338.0 [322.2–411.5] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 621 | — |
| trpc-server | config | full | 304.6 [288.5–321.5] | 140.2 | 95.3 | 31.6 | 5.0 | 165.0 | 0.9 | 0.8 | 0.0 | 0.8 | 0.7 | full | 84/84 | 0 | 0/196 | 826 | true |
| trpc-server | config | partial | 147.0 [140.0–150.2] | 141.9 | 98.3 | 37.8 | 4.8 | 3.0 | 0.7 | 0.3 | 0.0 | 0.8 | 0.7 | partial | 1/84 | 0 | 0/196 | 905 | true |
| trpc-server | config | full-noold | 313.9 [290.5–346.6] | 140.6 | 99.7 | 32.3 | 4.9 | 165.6 | 0.9 | 0.7 | 0.1 | 0.8 | 0.8 | full | 84/84 | 0 | 0/196 | 894 | true |
| trpc-server | config | partial-noold | 148.8 [138.8–155.6] | 138.1 | 100.3 | 31.0 | 4.8 | 3.1 | 0.6 | 0.3 | 0.0 | 0.8 | 0.7 | partial | 1/84 | 0 | 0/196 | 863 | true |
| trpc-server | addition | cold | 340.1 [323.8–409.2] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 620 | — |
| trpc-server | addition | full | 317.0 [290.7–364.1] | 147.7 | 101.5 | 39.4 | 5.2 | 167.2 | 0.8 | 0.7 | 0.1 | 0.7 | 0.4 | full | 86/86 | 1 | 1/199 | 824 | true |
| trpc-server | addition | partial | 311.6 [297.8–338.3] | 136.8 | 98.1 | 31.7 | 4.8 | 172.1 | 0.8 | 0.6 | 0.1 | 0.8 | 0.4 | full | 86/86 | 1 | 1/199 | 900 | true |
| trpc-server | addition | full-noold | 311.0 [294.2–342.0] | 137.7 | 99.9 | 31.1 | 4.8 | 166.7 | 0.8 | 0.7 | 0.1 | 0.8 | 0.4 | full | 86/86 | 1 | 1/199 | 896 | true |
| trpc-server | addition | partial-noold | 303.1 [295.6–340.6] | 138.2 | 98.1 | 31.5 | 4.7 | 160.4 | 0.8 | 0.7 | 0.1 | 0.8 | 0.4 | full | 86/86 | 1 | 1/199 | 892 | true |
| trpc-server | tsconfig | cold | 305.2 [300.5–342.8] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 719 | — |
| trpc-server | tsconfig | full | 308.0 [292.8–339.3] | 136.4 | 97.0 | 30.7 | 4.7 | 171.0 | 0.8 | 0.6 | 0.1 | 0.8 | 0.6 | full | 83/83 | 0 | 0/196 | 809 | true |
| trpc-server | tsconfig | partial | 316.6 [298.7–358.8] | 138.2 | 99.2 | 32.3 | 4.9 | 170.6 | 0.8 | 0.7 | 0.0 | 0.8 | 0.6 | full | 83/83 | 0 | 0/196 | 896 | true |
| trpc-server | tsconfig | full-noold | 302.9 [298.8–322.7] | 132.1 | 95.0 | 30.7 | 4.7 | 168.8 | 0.8 | 0.7 | 0.0 | 0.7 | 0.6 | full | 83/83 | 0 | 0/196 | 945 | true |
| trpc-server | tsconfig | partial-noold | 301.6 [292.1–335.0] | 136.2 | 98.5 | 30.8 | 4.7 | 162.9 | 0.8 | 0.7 | 0.1 | 0.8 | 0.6 | full | 83/83 | 0 | 0/196 | 895 | true |
| drizzle-orm | leaf | cold | 1947.4 [1872.8–2086.4] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1788 | — |
| drizzle-orm | leaf | full | 1961.7 [1892.4–2068.5] | 288.6 | 201.4 | 76.8 | 6.2 | 1645.0 | 4.4 | 6.1 | 0.6 | 5.5 | 4.3 | full | 448/448 | 0 | 0/2652 | 2244 | true |
| drizzle-orm | leaf | partial | 330.9 [314.6–335.4] | 293.0 | 204.2 | 75.7 | 6.1 | 20.0 | 0.2 | 3.6 | 0.4 | 4.3 | 4.0 | partial | 1/448 | 0 | 0/2652 | 2066 | true |
| drizzle-orm | leaf | full-noold | 1927.1 [1919.4–2035.0] | 305.5 | 223.4 | 75.9 | 6.3 | 1609.2 | 4.4 | 6.0 | 0.6 | 4.9 | 4.4 | full | 448/448 | 0 | 0/2652 | 2145 | true |
| drizzle-orm | leaf | partial-noold | 365.9 [340.1–392.9] | 313.7 | 224.6 | 76.2 | 6.3 | 21.5 | 0.2 | 4.0 | 0.5 | 5.1 | 4.0 | partial | 1/448 | 0 | 0/2652 | 1723 | true |
| drizzle-orm | hub | cold | 1969.4 [1892.8–2276.5] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1737 | — |
| drizzle-orm | hub | full | 1976.5 [1876.0–2014.8] | 285.1 | 199.8 | 74.2 | 6.2 | 1648.3 | 4.7 | 6.7 | 0.6 | 5.4 | 4.4 | full | 448/448 | 0 | 0/2652 | 2264 | true |
| drizzle-orm | hub | partial | 1942.1 [1862.2–2098.5] | 292.1 | 204.8 | 74.3 | 6.1 | 1645.1 | 5.5 | 6.1 | 0.7 | 5.4 | 4.6 | partial | 432/448 | 0 | 0/2652 | 2119 | true |
| drizzle-orm | hub | full-noold | 1939.1 [1846.8–2047.3] | 305.5 | 218.7 | 74.1 | 6.2 | 1599.3 | 4.7 | 5.8 | 0.6 | 5.8 | 4.6 | full | 448/448 | 0 | 0/2652 | 2133 | true |
| drizzle-orm | hub | partial-noold | 1995.8 [1918.2–2125.3] | 321.2 | 235.7 | 76.2 | 6.2 | 1647.0 | 5.9 | 6.1 | 0.6 | 5.3 | 4.7 | partial | 432/448 | 0 | 0/2652 | 2186 | true |
| drizzle-orm | jsdoc | cold | 1916.4 [1850.9–2228.6] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1760 | — |
| drizzle-orm | jsdoc | full | 1945.1 [1895.0–2032.1] | 283.0 | 203.5 | 73.2 | 6.2 | 1637.4 | 4.6 | 6.7 | 6.3 | 6.1 | 4.7 | full | 448/448 | 1 | 720/2651 | 2220 | true |
| drizzle-orm | jsdoc | partial | 1955.6 [1869.5–2033.6] | 285.5 | 196.0 | 75.7 | 6.1 | 1630.1 | 5.7 | 6.8 | 5.8 | 6.1 | 4.9 | partial | 432/448 | 1 | 720/2651 | 2137 | true |
| drizzle-orm | jsdoc | full-noold | 1916.0 [1837.1–2083.3] | 305.1 | 219.1 | 76.2 | 6.0 | 1579.5 | 4.6 | 6.7 | 6.8 | 5.6 | 4.5 | full | 448/448 | 1 | 720/2651 | 2175 | true |
| drizzle-orm | jsdoc | partial-noold | 1986.7 [1900.2–2098.3] | 293.5 | 210.5 | 73.3 | 6.0 | 1633.4 | 5.5 | 6.2 | 5.6 | 5.6 | 8.6 | partial | 432/448 | 1 | 720/2651 | 2124 | true |
| drizzle-orm | config | cold | 2045.6 [1834.2–2068.9] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1399 | — |
| drizzle-orm | config | full | 1903.1 [1815.7–2172.2] | 283.4 | 204.0 | 73.5 | 6.1 | 1558.4 | 4.6 | 6.1 | 0.6 | 6.3 | 4.6 | full | 449/449 | 0 | 0/2651 | 2157 | true |
| drizzle-orm | config | partial | 331.0 [318.0–354.8] | 286.7 | 201.4 | 73.9 | 6.2 | 19.2 | 3.8 | 4.3 | 0.4 | 4.4 | 4.4 | partial | 1/449 | 0 | 0/2651 | 2106 | true |
| drizzle-orm | config | full-noold | 1955.6 [1916.0–2031.4] | 306.9 | 217.9 | 77.1 | 6.0 | 1625.3 | 9.6 | 5.9 | 0.6 | 5.2 | 4.6 | full | 449/449 | 0 | 0/2651 | 2256 | true |
| drizzle-orm | config | partial-noold | 345.2 [341.8–359.1] | 301.3 | 217.5 | 75.2 | 6.2 | 20.0 | 3.7 | 4.3 | 0.5 | 5.1 | 4.1 | partial | 1/449 | 0 | 0/2651 | 2124 | true |
| drizzle-orm | addition | cold | 1985.4 [1890.5–2171.8] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1469 | — |
| drizzle-orm | addition | full | 1969.6 [1901.9–2038.3] | 305.0 | 220.6 | 73.2 | 6.2 | 1619.3 | 4.3 | 5.9 | 0.8 | 5.3 | 4.3 | full | 451/451 | 1 | 1/2654 | 2107 | true |
| drizzle-orm | addition | partial | 1952.3 [1888.7–2126.0] | 306.6 | 220.3 | 75.2 | 6.1 | 1608.8 | 4.6 | 6.0 | 0.7 | 5.2 | 4.3 | full | 451/451 | 1 | 1/2654 | 2139 | true |
| drizzle-orm | addition | full-noold | 1950.4 [1884.3–2216.2] | 301.7 | 219.6 | 71.9 | 6.3 | 1602.9 | 4.6 | 6.2 | 0.8 | 5.2 | 4.4 | full | 451/451 | 1 | 1/2654 | 2047 | true |
| drizzle-orm | addition | partial-noold | 1933.3 [1903.7–2022.9] | 311.3 | 217.4 | 76.0 | 6.1 | 1598.3 | 4.5 | 6.1 | 0.8 | 4.7 | 4.2 | full | 451/451 | 1 | 1/2654 | 2401 | true |
| drizzle-orm | tsconfig | cold | 2037.4 [1970.7–2212.9] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 1383 | — |
| drizzle-orm | tsconfig | full | 1957.9 [1868.2–2057.0] | 301.4 | 213.8 | 76.3 | 6.1 | 1629.9 | 4.3 | 6.0 | 0.6 | 4.8 | 4.5 | full | 448/448 | 0 | 0/2651 | 2125 | true |
| drizzle-orm | tsconfig | partial | 2097.5 [1986.6–2171.3] | 336.9 | 240.9 | 81.5 | 6.8 | 1687.1 | 4.8 | 6.5 | 0.7 | 5.6 | 4.6 | full | 448/448 | 0 | 0/2651 | 2027 | true |
| drizzle-orm | tsconfig | full-noold | 2015.5 [1922.7–2309.8] | 323.7 | 221.3 | 80.3 | 6.6 | 1671.7 | 4.7 | 5.9 | 0.6 | 5.2 | 4.2 | full | 448/448 | 0 | 0/2651 | 2219 | true |
| drizzle-orm | tsconfig | partial-noold | 2002.3 [1862.8–2303.7] | 322.5 | 232.0 | 79.0 | 6.3 | 1626.3 | 5.1 | 7.6 | 0.6 | 5.4 | 4.5 | full | 448/448 | 0 | 0/2651 | 1865 | true |
| immich-server | leaf | cold | 10360.9 [10010.3–10651.7] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 2511 | — |
| immich-server | leaf | full | 11581.7 [11308.3–11908.8] | 2642.8 | 1845.8 | 773.5 | 20.7 | 8817.4 | 95.1 | 25.2 | 1.2 | 23.0 | 4.0 | full | 557/557 | 0 | 0/3192 | 2506 | true |
| immich-server | leaf | partial | 2199.7 [1855.6–2479.2] | 2113.6 | 1464.5 | 336.6 | 22.4 | 28.9 | 0.4 | 14.1 | 0.8 | 19.0 | 3.1 | partial | 1/557 | 0 | 0/3192 | 2710 | true |
| immich-server | leaf | full-noold | 10928.1 [10732.3–11216.9] | 2046.7 | 1417.1 | 334.1 | 20.9 | 9004.7 | 97.0 | 23.7 | 1.1 | 22.2 | 3.8 | full | 557/557 | 0 | 0/3192 | 2655 | true |
| immich-server | leaf | partial-noold | 1496.1 [1439.8–2009.5] | 1426.8 | 1103.3 | 299.9 | 20.5 | 28.6 | 0.5 | 10.2 | 0.6 | 19.7 | 2.9 | partial | 1/557 | 0 | 0/3192 | 2484 | true |
| immich-server | hub | cold | 9813.0 [9616.4–9992.0] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 2741 | — |
| immich-server | hub | full | 10517.5 [10388.5–10552.4] | 2330.2 | 1735.9 | 326.9 | 20.3 | 8079.6 | 88.2 | 16.5 | 1.0 | 21.5 | 3.8 | full | 557/557 | 0 | 0/3192 | 3242 | true |
| immich-server | hub | partial | 10479.2 [10343.2–11300.3] | 2270.9 | 1879.3 | 312.5 | 20.4 | 8013.9 | 83.9 | 19.0 | 1.1 | 20.2 | 4.0 | partial | 427/557 | 0 | 0/3192 | 2946 | true |
| immich-server | hub | full-noold | 11771.4 [10600.3–12760.3] | 1743.8 | 1393.2 | 324.5 | 21.3 | 9888.2 | 102.1 | 20.8 | 1.1 | 21.9 | 3.7 | full | 557/557 | 0 | 0/3192 | 2901 | true |
| immich-server | hub | partial-noold | 10611.6 [10429.9–10865.1] | 1748.1 | 1395.9 | 327.9 | 20.6 | 8639.1 | 86.8 | 19.1 | 1.1 | 23.5 | 3.8 | partial | 427/557 | 0 | 0/3192 | 2851 | true |
| immich-server | jsdoc | cold | 9740.2 [9527.3–9868.6] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 2663 | — |
| immich-server | jsdoc | full | 10424.8 [10253.2–10847.9] | 2286.0 | 1759.7 | 597.6 | 20.0 | 7995.4 | 88.7 | 16.1 | 1.0 | 21.5 | 3.6 | full | 557/557 | 1 | 2/3191 | 3143 | true |
| immich-server | jsdoc | partial | 10187.3 [10152.2–11091.4] | 2172.6 | 1601.4 | 526.4 | 19.8 | 7915.6 | 84.2 | 16.8 | 1.0 | 22.5 | 3.8 | partial | 419/557 | 1 | 2/3191 | 3053 | true |
| immich-server | jsdoc | full-noold | 10411.9 [10321.8–10493.2] | 1749.5 | 1387.8 | 329.0 | 20.5 | 8448.6 | 91.9 | 25.1 | 1.0 | 19.5 | 3.7 | full | 557/557 | 1 | 2/3191 | 3093 | true |
| immich-server | jsdoc | partial-noold | 11398.1 [9752.7–12870.4] | 1888.5 | 1451.5 | 333.2 | 20.9 | 9308.1 | 89.1 | 20.5 | 1.0 | 20.0 | 4.1 | partial | 419/557 | 1 | 2/3191 | 2795 | true |
| immich-server | config | cold | 9909.8 [9546.8–10577.9] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 2930 | — |
| immich-server | config | full | 10280.1 [10158.8–11561.2] | 2017.5 | 1557.1 | 328.8 | 20.6 | 8262.4 | 88.6 | 16.0 | 1.0 | 21.7 | 3.3 | full | 557/557 | 0 | 0/3191 | 3272 | true |
| immich-server | config | partial | 1951.2 [1807.3–2146.5] | 1796.1 | 1437.0 | 322.3 | 19.9 | 28.6 | 96.1 | 8.6 | 0.7 | 19.3 | 2.9 | partial | 0/557 | 0 | 0/3191 | 2978 | true |
| immich-server | config | full-noold | 10165.9 [9974.1–11441.9] | 1688.5 | 1347.6 | 316.0 | 20.3 | 8509.2 | 88.5 | 19.1 | 0.9 | 22.5 | 3.4 | full | 557/557 | 0 | 0/3191 | 3920 | true |
| immich-server | config | partial-noold | 1467.0 [1454.2–1592.4] | 1287.4 | 968.1 | 294.0 | 19.3 | 25.9 | 125.7 | 8.1 | 0.7 | 18.7 | 2.9 | partial | 0/557 | 0 | 0/3191 | 2825 | true |
| immich-server | addition | cold | 10064.2 [9786.1–10566.3] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 2782 | — |
| immich-server | addition | full | 9898.8 [9633.4–10037.8] | 1608.9 | 1273.3 | 312.1 | 20.2 | 8160.6 | 86.5 | 17.2 | 1.1 | 21.7 | 3.1 | full | 560/560 | 1 | 1/3194 | 3143 | true |
| immich-server | addition | partial | 10007.7 [9662.9–10145.9] | 1681.9 | 1287.9 | 300.0 | 20.3 | 7955.7 | 112.6 | 15.0 | 1.1 | 21.5 | 3.5 | full | 560/560 | 1 | 1/3194 | 3257 | true |
| immich-server | addition | full-noold | 10944.1 [9893.5–12102.8] | 1717.9 | 1364.0 | 317.7 | 20.2 | 9002.2 | 95.1 | 20.7 | 1.3 | 22.5 | 3.8 | full | 560/560 | 1 | 1/3194 | 3281 | true |
| immich-server | addition | partial-noold | 10374.0 [10313.3–12201.1] | 1753.5 | 1397.1 | 322.0 | 20.2 | 8503.5 | 88.7 | 18.3 | 1.2 | 23.5 | 3.8 | full | 560/560 | 1 | 1/3194 | 3138 | true |
| immich-server | tsconfig | cold | 12058.6 [10757.3–12791.4] | — | — | — | — | — | — | — | — | — | — | — | — | — | — | 2599 | — |
| immich-server | tsconfig | full | 10601.7 [10029.4–11059.1] | 1765.1 | 1344.1 | 321.8 | 20.8 | 8784.7 | 96.1 | 18.7 | 1.1 | 23.8 | 3.5 | full | 557/557 | 0 | 0/3191 | 3019 | true |
| immich-server | tsconfig | partial | 10831.0 [10632.6–11377.3] | 1779.5 | 1431.3 | 323.2 | 20.6 | 8803.6 | 119.7 | 23.8 | 1.1 | 23.3 | 3.5 | full | 557/557 | 0 | 0/3191 | 2645 | true |
| immich-server | tsconfig | full-noold | 10403.2 [9873.4–10503.1] | 1709.8 | 1345.5 | 330.3 | 20.2 | 8543.7 | 92.3 | 25.3 | 1.1 | 22.2 | 3.4 | full | 557/557 | 0 | 0/3191 | 3055 | true |
| immich-server | tsconfig | partial-noold | 10370.9 [10213.1–10789.1] | 1692.0 | 1343.2 | 322.6 | 20.7 | 8518.7 | 115.8 | 22.2 | 1.0 | 20.3 | 3.5 | full | 557/557 | 0 | 0/3191 | 3111 | true |
