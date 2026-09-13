# Resident workload: what edits the resident path would be handed

Run on 2026-09-13, Node.js v24.20.0, TypeScript 6.0.3 (`typescript-legacy`),
macOS (darwin arm64), Apple M1, 16 GiB — the machine of
[phase 5](2026-09-13-resident-benchmark.md) and
[the contract-only narrowing run](2026-09-13-resident-jsdoc-narrowing.md).
Nothing in `src/` changed for it. `docs/status.md` carries the verdict.

## Procedure

```sh
cp -R <claude-code-project-dir> sessions        # freeze the input
node scripts/observe-resident-workload.ts trace --sessions sessions --classify-only --out c1.json
node scripts/observe-resident-workload.ts trace --sessions sessions --classify-only --out c2.json
node scripts/observe-resident-workload.ts trace --sessions sessions --iterations 3 --noold --out trace.json
node scripts/observe-resident-workload.ts git --out git.json
node scripts/observe-resident-workload.ts summary trace.json git.json
```

Two sources, reported separately and never merged. Neither is an adopter's
workload: both are this repository, `check src`, 49 files / 420 functions.

**Trace — real agent sessions, assumed cadence.** 327 Claude Code JSONL streams
(sessions and subagents) recorded on this repository, 39 of them with edits,
copied once so every run reads the same bytes. Every Edit and Write is rebuilt as
a before/after pair and classified with the backend's own `classifyJsDocEdit`.
The pre-edit text is the log's `originalFile` (181 edits); where the log omits
it, the stream's last full text of that file — an earlier edit's result or a
whole-file Read — provided the edit's `oldString` is found in it and no shell
command that can rewrite sources ran in between (22 edits). The remaining 204
edits have no pre-edit text. Nobody ran the resident path during those
sessions, so when a check would have run is assumed, at two grains: every tool
call is a batch (`call`, editor-like), and the edits between two Bash calls are
a batch (`bash`, agent-loop-like). The texts are from older trees, so closure
and latency are **estimated on the current tree**: each batch's shape (which
files; code, contract or both) is re-applied as a synthetic edit of that kind to
the same files and measured through `ResidentSession` — median of 3 after one
unmeasured application. Batches the product would answer with a whole rebuild
are measured as `update()` without a change set.

**Git — commit workload proxy.** The 105 first-parent commits that touch `src`,
`test` or the project config (2026-09-08 → 2026-09-13). Each commit's parent
`src`, `test`, `tsconfig.json` and `package.json` are extracted from git and
opened as a session **against the current installed `node_modules`** (a
symlink, not the dependencies the commit was written against); the commit's diff
is written and one `update(changes)` is measured. These are historical source
trees, not historical programs. Commits here are squash-merged pull requests:
PR grain, far coarser than any editor event.

The artifacts (JSON) hold hashed stream ids, repository-relative paths and
numbers only; they are not committed.

**Determinism.** The two `--classify-only` runs over the frozen input produced
byte-identical streams, edit-source counts and batches. The git run was not
repeated; its classification reads only git objects. Latency is not
deterministic and is not claimed to be.

## Taxonomy

Per file, `classifyJsDocEdit`'s `unsafe` is split by whether any line carrying
one of the five contract tags moved — a text signal, so `code-only` includes
`@param` and description edits the classifier refuses. Per batch, the widest
§6.2 row wins: `config` › `add-delete-rename` › `other-unknown` › `outside-root`
› `mixed-contract-code` / `contract-only` / `code-only`.

- `outside-root` — a `test/**/*.ts` file (in the tsconfig project, outside the
  checked root). §6.2 makes it every file, so it is measured as a full update.
- `other-unknown` — not classified, on purpose. In the `call` grain, 144 batches
  hold an edit with no pre-edit text (or one that does not parse), and 217 are a
  Bash command mentioning `src/` with `rm`, `mv`, `git
  checkout|restore|stash|reset|apply`, `sed -i` or `patch`. That regex is
  deliberately wide; some of those never touched a project file.
- `no-project-change` — docs, scripts, fixtures, no-op writes. Excluded from %.

## Edit class frequency

% of batches touching the project; "classified" excludes `other-unknown`.

| class | trace `call` n (% all / % classified) | trace `bash` n (% all / % classified) | git n (%) |
|---|---|---|---|
| contract-only | 1 (0.2 / 0.6) | 0 | 0 |
| code-only | 61 (11.7 / 37.7) | 22 (6.7 / 25.6) | 3 (2.9) |
| mixed-contract-code | 5 (1.0 / 3.1) | 3 (0.9 / 3.5) | 4 (3.9) |
| add-delete-rename | 27 (5.2 / 16.7) | 16 (4.9 / 18.6) | 19 (18.4) |
| config | 6 (1.1 / 3.7) | 5 (1.5 / 5.8) | 14 (13.6) |
| outside-root | 62 (11.9 / 38.3) | 40 (12.3 / 46.5) | 63 (61.2) |
| other-unknown | 361 (69.0 / —) | 240 (73.6 / —) | 0 (2 commits failed to open) |
| **touching the project** | 523 | 326 | 103 |

In-root part of the `outside-root` batches: trace `call` 62 × nothing in `src`;
trace `bash` 39 × nothing, 1 × code-only; git 25 × code-only, 18 × mixed, 20 ×
nothing. Contract-tag edits are rare at every grain: 1 contract-only edit in 745
tool calls. Every mixed batch in the trace contains a same-file mixed edit (code
and a contract tag moved in one file); none pairs a contract-only file with a
code file, which is the only shape mixed narrowing could shrink.

## Closure distribution (union importer closure, files of 49)

| class | trace `call` p50 / p75 / p90 / max (n) | trace `bash` | git (parent graph) |
|---|---|---|---|
| contract-only | 1 / 1 / 1 / 1 (1) | — | — |
| code-only | 9 / 10 / 35 / 36 (61) | 9 / 32 / 36 / 36 (22) | 3 / 4 / 4 / 4 (3) |
| mixed-contract-code | 36 / 36 / 39 / 39 (5) | 36 / 36 / 36 / 36 (3) | 3 / 4 / 6 / 6 (4) |
| add-delete-rename (in-root seeds) | 8 / 34 / 37 / 38 (27) | 8 / 33 / 36 / 40 (16) | 16 / 21 / 31 / 33 (17) |

Samples below 20 are listed for completeness, not as distributions.

## Latency and latency-weighted contribution

**Every share below is of the summed cost of the classified, measured batches** —
not of the workload. `other-unknown` batches have no cost estimate, and in the
trace they are 69–74% of batches.

Trace, estimated on the current tree; p50 total per class and Σ over batches.

| class | `call` total p50 (ms) | project-update p50 | extraction p50 | `call` Σ ms (% of measured Σ) | `bash` Σ ms (% of measured Σ) |
|---|---:|---:|---:|---|---|
| contract-only | 444 | 416 | 26 | 444 (0.5) | — |
| code-only | 553 | 428 | 139 | 34,399 (35.6) | 12,564 (24.3) |
| mixed-contract-code | 625 | 426 | 196 | 1,848 (1.9) | 562 (1.1) |
| add-delete-rename (full) | 632 | 419 | 209 | 17,072 (17.6) | 10,117 (19.6) |
| config (full) | 632 | 419 | 209 | 3,794 (3.9) | 3,162 (6.1) |
| outside-root (full) | 632 | 419 | 209 | 39,203 (40.5) | 25,293 (48.9) |

- Measured Σ: `call` 96,761 ms, of which full-verdict updates 62.1% and partial
  updates' project-update 28.6% (createProgram + getTypeChecker 27,111 ms).
  `bash` 51,697 ms: full 74.6%, partial project-update 19.0% (9,607 ms).
- Git, measured: Σ 53,896 ms over 101 opened commits, full-verdict 93.3%,
  partial project-update 4.8% (createProgram + getTypeChecker 2,526 ms).
  `outside-root` alone is 69.2% (p50 591 ms, max 1,924 ms).
- Cost spread between classes is small on this subject: the cheapest partial
  (contract-only, 444 ms) and a full rebuild (632 ms) differ by under 200 ms,
  because project-update (≈ 420 ms) is in every row.
- **Agent-loop gap:** between consecutive project-touching `bash` batches in one
  stream, p50 52 s, p90 586 s (n = 291). The re-check is ≈ 0.4–0.7 s of it.

### Top 3 costly workload shapes (among measured batches)

| rank | trace `call` | trace `bash` | git |
|---|---|---|---|
| 1 | outside-root / full: 39.2 s over 62 | outside-root / full: 25.3 s over 40 | outside-root / full: 37.3 s over 63 |
| 2 | code-only / partial: 34.4 s over 61 | code-only / partial: 12.6 s over 22 | add-delete-rename / full: 7.4 s over 19 |
| 3 | add-delete-rename / full: 17.1 s over 27 | add-delete-rename / full: 10.1 s over 16 | config / full: 5.6 s over 12 |

## Upper-bound savings (of measured Σ)

- **Mixed change set narrowing** — each mixed shape minus the same batch with
  its contract edits removed: Σ 33 ms (`call`, 3 batches), 0 ms (`bash`, 1).
  Every observed mixed batch edits code in the same file as the tag, so that
  file cannot leave the closure seed; the difference is noise. 2 of 5 `call`
  mixed batches (`core/backend.ts`, interfaces only) are unmeasured: the
  synthetic contract edit found no top-level function to attach to.
- **Architecture C** — if program construction were free for every partial
  update: at most createProgram + getTypeChecker of partial batches, 27.1 s of
  96.8 s (`call`, 28%), 9.6 s of 51.7 s (`bash`, 19%), 2.5 s of 53.9 s (git,
  5%). It does not reach the full-rebuild rows.
- **oldProgram withheld** (`--noold`, same shapes): `call` Σ 102,056 ms against
  96,761 ms with it, `bash` 54,622 against 51,697 — 5–6% slower without it. A
  first run of the same procedure on the unfrozen logs (which differ by this
  session's own edits) went the other way, 5% *faster* without it. The sign does
  not survive a re-run, so this procedure cannot separate `oldProgram`'s effect
  on a 49-file project, and it says nothing about immich.

## What is not measured

- **Any project but this one.** 49 files; closure and cost scale are not
  drizzle-orm's or immich's. The workload is agents building Ambit, not adopters
  using it.
- **When a check would actually run.** Both trace grains are assumptions; no
  session ran the resident path.
- **69–74% of trace batches**, left `other-unknown` rather than guessed. The
  shares above exclude them; the true workload's shares can differ.
- **Trace latency on the trees it came from.** The shapes are replayed on the
  current tree; one shape (`core/backend.ts`, contract + code) could not be
  replayed.
- **Git latency against the dependencies each commit had.** Every commit ran
  against today's `node_modules`.
- **Editor (keystroke/save) workloads**, `.tsx`, and dependency-installed
  third-party projects.
