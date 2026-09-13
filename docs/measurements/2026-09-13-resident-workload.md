# Resident workload: what edits the resident path would be handed

Run on 2026-09-13 at `21dd15f`, Node.js v24.20.0, TypeScript 6.0.3
(`typescript-legacy`), macOS (darwin arm64), Apple M1, 16 GiB — the machine of
[phase 5](2026-09-13-resident-benchmark.md) and
[the contract-only narrowing run](2026-09-13-resident-jsdoc-narrowing.md).
Nothing in `src/` changed for it. `docs/status.md` carries the verdict.

## Procedure

```sh
node scripts/observe-resident-workload.ts trace --sessions <claude-code-project-dir> \
  --iterations 3 --noold --out trace.json
node scripts/observe-resident-workload.ts git --out git.json
node scripts/observe-resident-workload.ts summary trace.json git.json
```

Two sources, reported separately and never merged. Neither is an adopter's
workload: both are this repository, `check src`, 49 files / 420 functions.

**Trace — real agent sessions, assumed cadence.** 325 Claude Code JSONL streams
(sessions and subagents) recorded on this repository, 39 of them with edits.
Every Edit and Write result that carries the file's pre-edit text is rebuilt as
a before/after pair and classified with the backend's own `classifyJsDocEdit`.
Nobody ran the resident path during those sessions, so when a check would have
run is assumed, at two grains: every tool call is a batch (`call`, editor-like),
and the edits between two Bash calls are a batch (`bash`, agent-loop-like). The
texts are from older trees, so closure and latency are **estimated on the
current tree**: each batch's shape (which files; code, contract or both) is
re-applied as a synthetic edit of that kind to the same files and measured
through `ResidentSession` — median of 3 after one unmeasured application. Batches
the product would answer with a whole rebuild are measured as `update()` without
a change set.

**Git — commit workload proxy, exact trees.** The 105 first-parent commits that
touch `src`, `test` or the project config (2026-09-08 → 2026-09-13). The parent's
tree is opened as a session, the commit's diff is written, and one
`update(changes)` is measured. Commits here are squash-merged pull requests: this
is PR grain, far coarser than any editor event.

The artifacts (JSON) hold hashed stream ids, repository-relative paths and
numbers only; they are not committed.

## Taxonomy

Per file, `classifyJsDocEdit`'s `unsafe` is split by whether any line carrying
one of the five contract tags moved — a text signal, so `code-only` includes
`@param` and description edits the classifier refuses. Per batch, the widest
§6.2 row wins: `config` › `add-delete-rename` › `other-unknown` › `outside-root`
› `mixed-contract-code` / `contract-only` / `code-only`.

- `outside-root` — a `test/**/*.ts` file (in the tsconfig project, outside the
  checked root). §6.2 makes it every file, so it is measured as a full update.
- `other-unknown` — not classified, on purpose: an Edit whose log has no
  pre-edit text (133 on `src/`, 86 of them on the 164 KB `legacy-ts.ts`), a
  pre-edit text that does not parse, or a Bash command mentioning `src/` with
  `rm`, `mv`, `git checkout|restore|stash|reset|apply`, `sed -i` or `patch` (293).
  The regex is deliberately wide; some of those never touched a project file.
- `no-project-change` — docs, scripts, fixtures, no-op writes. Excluded from %.

## Edit class frequency

% of batches touching the project. "classified" excludes `other-unknown`.

| class | trace `call` n (% all / % classified) | trace `bash` n (% all / % classified) | git n (%) |
|---|---|---|---|
| contract-only | 1 (0.2 / 0.7) | 0 | 0 |
| code-only | 56 (10.5 / 36.6) | 19 (5.8 / 22.9) | 3 (2.9) |
| mixed-contract-code | 5 (0.9 / 3.3) | 2 (0.6 / 2.4) | 4 (3.9) |
| add-delete-rename | 27 (5.1 / 17.6) | 18 (5.5 / 21.7) | 19 (18.4) |
| config | 6 (1.1 / 3.9) | 5 (1.5 / 6.0) | 14 (13.6) |
| outside-root | 58 (10.9 / 37.9) | 39 (11.9 / 47.0) | 63 (61.2) |
| other-unknown | 379 (71.2 / —) | 245 (74.7 / —) | 0 (2 commits failed to open) |
| **touching the project** | 532 | 328 | 103 |

In-root part of the `outside-root` batches: trace `call` 58 × nothing in `src`;
trace `bash` 38 × nothing, 1 × code-only; git 25 × code-only, 18 × mixed, 20 ×
nothing. Contract-tag edits are rare at every grain: 1 contract-only edit in 740
tool calls, and every mixed batch in the trace contains a same-file mixed edit (code and a
contract tag moved in one file); none pairs a contract-only file with a code
file, which is the only shape mixed narrowing could shrink.

## Closure distribution (union importer closure, files of 49)

| class | trace `call` p50 / p75 / p90 / max (n) | trace `bash` | git (parent graph) |
|---|---|---|---|
| contract-only | 1 / 1 / 1 / 1 (1) | — | — |
| code-only | 9 / 10 / 35 / 36 (56) | 10 / 35 / 36 / 36 (19) | 3 / 4 / 4 / 4 (3) |
| mixed-contract-code | 36 / 36 / 39 / 39 (5) | 9 / 36 / 36 / 36 (2) | 3 / 4 / 6 / 6 (4) |
| add-delete-rename (in-root seeds) | 8 / 34 / 37 / 38 (27) | 10 / 35 / 39 / 40 (18) | 16 / 21 / 31 / 33 (17) |

Samples below 20 are listed for completeness, not as distributions.

## Latency and latency-weighted contribution

Trace, estimated on the current tree; p50 total per class and Σ over batches.

| class | `call` total p50 (ms) | project-update p50 | extraction p50 | Σ ms (% of Σ) | `bash` Σ ms (% of Σ) |
|---|---:|---:|---:|---|---|
| contract-only | 434 | 403 | 28 | 434 (0.4) | — |
| code-only | 549 | 410 | 141 | 31,948 (32.9) | 10,571 (19.6) |
| mixed-contract-code | 596 | 403 | 188 | 1,739 (1.8) | 545 (1.0) |
| add-delete-rename (full) | 691 | 459 | 227 | 18,651 (19.2) | 12,434 (23.0) |
| config (full) | 691 | 459 | 227 | 4,145 (4.3) | 3,454 (6.4) |
| outside-root (full) | 691 | 459 | 227 | 40,066 (41.3) | 26,941 (49.9) |

- Σ over measured batches: `call` 96,984 ms, of which full-verdict updates 64.8%
  and partial updates' project-update 27.0% (createProgram + getTypeChecker
  25,711 ms of that). `bash` 53,946 ms: full 79.4%, partial project-update 15.6%.
- Git, measured on exact trees: Σ 53,896 ms, full-verdict 93.3%, partial
  project-update 4.8%. `outside-root` alone is 69.2% (p50 591 ms, max 1,924 ms).
- Cost spread between classes is small on this subject: the cheapest partial
  (contract-only, 434 ms) and a full rebuild (691 ms) differ by 257 ms, because
  project-update (≈ 400–460 ms) is in every row.
- **Agent-loop gap:** between consecutive project-touching `bash` batches in one
  stream, p50 48 s, p90 586 s (n = 294). The re-check is ≈ 0.4–0.7 s of it.

### Top 3 costly workload shapes

| rank | trace `call` | trace `bash` | git |
|---|---|---|---|
| 1 | outside-root / full: 40.1 s over 58 | outside-root / full: 26.9 s over 39 | outside-root / full: 37.3 s over 63 |
| 2 | code-only / partial: 31.9 s over 56 | add-delete-rename / full: 12.4 s over 18 | add-delete-rename / full: 7.4 s over 19 |
| 3 | add-delete-rename / full: 18.7 s over 27 | code-only / partial: 10.6 s over 19 | config / full: 5.6 s over 12 |

## Upper-bound savings

- **Mixed change set narrowing** — measured as each mixed shape minus the same
  batch with its contract edits removed: Σ 6 ms (`call`, 3 batches), 0 ms
  (`bash`). Every observed mixed batch edits code in the same file as the tag,
  so that file cannot leave the closure seed; the saving is noise. 2 of 5 `call`
  mixed batches (`core/backend.ts`, interfaces only) are unmeasured: the
  synthetic contract edit found no top-level function to attach to.
- **Architecture C** — if program construction were free for every partial
  update: at most createProgram + getTypeChecker of partial batches, 25.7 s of
  97.0 s (`call`), 8.3 s of 53.9 s (`bash`), 2.5 s of 53.9 s (git). It does not
  reach the full-rebuild rows, which are 65–93% of Σ.
- **oldProgram withheld** (`--noold`, same shapes): `call` Σ 92,411 ms against
  96,984 ms with it, `bash` 51,233 against 53,946. Partial rows are 30–60 ms
  slower without it (code-only p50 581 vs 549), full rows 54 ms faster (637 vs
  691). One run of 3 iterations per shape: a 5% spread on a 49-file project is
  within what this run can separate, and it says nothing about immich.

## What is not measured

- **Any project but this one.** 49 files; closure and cost scale are not
  drizzle-orm's or immich's. The workload is agents building Ambit, not adopters
  using it.
- **When a check would actually run.** Both trace grains are assumptions; no
  session ran the resident path.
- **71–75% of trace batches**, left `other-unknown` rather than guessed. The
  largest block is Edits whose log carries no pre-edit text; reconstructing them
  from an earlier edit's result in the same stream is possible and not done.
- **Trace latency on the trees it came from.** The shapes are replayed on
  `21dd15f`; one shape (`core/backend.ts`, contract + code) could not be replayed.
- **Editor (keystroke/save) workloads**, `.tsx`, and dependency-installed
  projects.
