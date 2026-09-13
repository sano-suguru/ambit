# Contract-only JSDoc narrowing, before and after

Run on 2026-09-13, Node.js v24.20.0, TypeScript 6.0.3 (`typescript-legacy`),
macOS (darwin arm64), Apple M1, 8 cores, 16 GiB — the machine of
[the phase 5 run](2026-09-13-resident-benchmark.md). What is measured is
[ADR-0015](../adr/0015-contract-only-jsdoc-edits.md);
`docs/status.md` carries the verdict.

## Procedure

`before` is a `git worktree` of `5918a57` (phase 5 as merged); `after` is the
working tree with the narrowing. Both sides run the same command, only the
`jsdoc` mutation, sequentially on an otherwise idle machine:

```sh
node scripts/bench-resident.ts --subjects ambit-src,drizzle-orm --mutations jsdoc \
  --warmup 1 --iterations 5 --out main.json
node scripts/bench-resident.ts --immich <checkout> --subjects immich-server \
  --mutations jsdoc --warmup 1 --iterations 3 --out immich.json
```

The mutation is phase 5's: a `/** @effects fs_read|fs_write */` line inserted
above an undocumented function in the file with the widest importer closure that
has one — `core/budget.ts` (ambit-src), `entity.ts` (drizzle-orm),
`validation.ts` (immich). It is worst-case-leaning by construction, not a typical
edit. Fewer iterations than phase 5 (1 + 5, 1 + 3 on immich); medians below,
min–max in the raw tables the script prints.

**The first `after` run is void.** `scripts/bench-resident.ts` wraps the backend
session to capture the `project-update` breakdown, and the wrapper forwarded two
of `update`'s three arguments. The product narrowed; the benchmark silently
measured the closure (432/448 and 419/557 re-extracted, unchanged from `before`).
The wrapper now forwards every argument and the verdict column prints
`partial (contract-only)`, so the same drop would be visible. The numbers below
are the re-run.

## Results — the `partial` scenario

| subject | re-extracted before → after | total p50 before → after (ms) | project-update | extraction | summarize | impact | propagate | report | S | I | = cold |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ambit-src | 39/49 → **1/49** | 652 → **474** | 446 → 450 | 205 → 11 | 2.2 → 0.1 | 1.3 → 1.0 | 0.3 → 0.3 | 1.3 → 1.4 | 1 | 16 | true |
| drizzle-orm | 432/448 → **1/448** | 2,275 → **345** | 387 → 292 | 1,933 → 26 | 6.4 → 0.3 | 6.9 → 3.9 | 7.4 → 12.8 | 6.8 → 4.9 | 1 | 720 | true |
| immich `server/src` | 419/557 → **1/557** | 10,215 → **2,185** | 1,959 → 2,076 | 8,048 → 72 | 88 → 0.6 | 14 → 8.6 | 1.0 → 0.7 | 23 → 19 | 1 | 2 | true |

`S` and `I` are unchanged on every subject: the narrowing skips re-extraction and
nothing else. `partial-noold` narrowed the same way (474 → 485 ms on ambit-src,
348 ms on drizzle-orm, 1,719 ms on immich). The two sides' `ambit-src` subjects
differ by this change's own source (413 → 420 functions).

Cold `analyze()` on the same trees, for scale: ambit-src 729 / 744 ms,
drizzle-orm 2,286 / 2,014 ms, immich 9,885 / 10,647 ms (before / after runs; the
cold path is untouched, so the spread is run-to-run noise).

## What it shows

- **Extraction stopped being the cost of a contract edit.** It fell to 11–72 ms.
- **`project-update` is now 85–95% of the re-check** (450 of 474, 292 of 345,
  2,076 of 2,185 ms). Pass 1, `createProgram` and `getTypeChecker` stay
  whole-project by design; nothing here touches them.
- Byte equivalence with cold held in every measured iteration on all three.

## Corpus benchmark

`node scripts/bench-corpus.ts` on both sides: output identical (`diff` empty) —
median unknown rate 52.9%, drizzle-orm 39.0%. The one-shot analysis is untouched.
