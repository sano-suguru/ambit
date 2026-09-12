# The resident check path

How `docs/DESIGN.md` §6.2 is to be built, for whoever builds it. §6.2 is the
specification and wins any disagreement with this file; the reasoning behind the
architecture is [ADR-0014](adr/0014-the-resident-check-path.md). Nothing here is
a new guarantee — §9.2 puts the existence of a resident path outside the
guaranteed surface, and this document adds no claim to it.

Status: **not implemented.** `docs/status.md` is where that changes.

## What is true today

Read, not assumed. Every line below was checked against the source before this
document was written, and each is load-bearing for a decision further down.

- `analyze()` (`src/cli/analyze.ts`) runs config load → `extractProject` →
  `summarizeExtractedFiles` → `propagate` → diagnostics / authority / coverage in
  one call. There is no state between calls, and `ambit diff` calls it twice.
- `extractProject` (`src/checker/backend/legacy-ts.ts`) builds a fresh
  `ts.createProgram({ rootNames, options })` every time. `oldProgram` is never
  passed.
- Extraction is two passes. Pass 1 is a syntactic walk that mints a `SymbolId`
  per declaration and builds a whole-project `Map<ts.Node, SymbolId>`; pass 2
  uses the checker and resolves calls through that map. **Pass 2 never reads a
  callee's JSDoc** — `extractJsDoc` is called on the declaration being extracted
  and in the skipped-function scan, nowhere else.
- A `SymbolId` is `<root-relative path>#<declaration path>` and contains nothing
  the compiler owns (§5.3), so the same declaration yields the same id in every
  generation.
- `propagate`'s `deriveState` rebuilds its witness maps from scratch on every
  pass, and the loop stores every summary's derived state on every pass. The
  terminating pass therefore re-derives every summary against final callee
  values: **the final witness maps are a function of (summary, final callee
  states)** and do not depend on how the fixed point was reached.
- `ResolvedConfig.contractFor` records matches into a private `matchedKeys` set
  as a side effect, and `unmatchedExactKeys()` reads it after a whole run.
  Re-summarizing a subset of files would report keys as unmatched that an earlier
  generation matched (a false `AMB-W006`).
- `ExtractedProject.skippedFunctions` and `uncarriedContracts` are project-level
  but are produced inside the per-file loop.
- An `ExtractedFile` is pushed only when `functions.length > 0 ||
  runtimeWrappers.length > 0`, and `coverage.filesAnalyzed` counts those.
- Authority records are sorted by symbol id (`src/checker/authority.ts`).
  **Diagnostics are not sorted** — they follow the state map's insertion order,
  which follows the backend's file order.
- The legacy backend's measured "re-query" is 214–272 ms on the gate-3 corpus,
  and that is a whole program rebuild, not an increment
  ([`docs/measurements/m0.5-backend-comparison.md`](measurements/m0.5-backend-comparison.md)).
  The 21.5 ms figure in the same file is marked superseded; it is not evidence.
  `check src` costs about 1.1 s ([`docs/status.md`](status.md)).

## Components

One new layer. Everything above it stays the pure function it already is.

| File | Change |
|---|---|
| `src/checker/resident.ts` | New. Generations, the store, impact, the scoped fixed point, timings |
| `src/core/backend.ts` | `TsBackend` gains an optional `openProject`; `ExtractedFile` gains three fields |
| `src/checker/backend/legacy-ts.ts` | Implements `openProject`, passing `oldProgram` |
| `src/checker/propagate.ts` | One additional entry point for the scoped fixed point. `propagate` itself is untouched and stays the oracle |
| `src/checker/summarize.ts`, `diagnose.ts`, `authority.ts`, `coverage.ts` | Unchanged |
| `src/cli/analyze.ts` | Unchanged. The cold path is what the resident path is tested against |

**No CLI flag.** A flag is guaranteed surface (§9.2) and needs its own
`CHANGELOG.md` entry; the consumers of this work are the tests and the
benchmark, which drive the session directly.

**`oldProgram` buys less than its name suggests on an add or a delete.**
`tryReuseStructureFromOldProgram` bails when the root names differ or when an
option affecting module resolution changed (verified in
`node_modules/typescript/lib/typescript.js`), so a file appearing or disappearing
re-parses the project unless the `CompilerHost` caches source files by version —
which watch mode's host does and the default host does not. Equivalence is
unaffected, and phase 4's claim is about pass 2, which still shrinks. A caching
`getSourceFile` is the lever if `project-update` turns out to dominate; measure
before reaching for it.

`test/architecture.test.ts` gains one rule: `src/checker/resident.ts` must not
import `typescript`.

### The backend extension

`TsBackend` is not broken — one optional method is added, and a backend without
it is driven through a default adapter that calls `extractProject` and reports a
full rebuild (ADR-0014's architecture A). Everything above the boundary is then
backend-independent, and `test/backend.conformance.test.ts` keeps passing
unchanged.

```ts
interface TsBackend {
  readonly name: string;
  readonly version: string;
  extractProject(rootDir: string): Promise<ExtractedProject>;
  openProject?(rootDir: string): Promise<TsProjectSession>;
}

interface TsProjectSession {
  update(changed: readonly FileChange[]): Promise<ExtractedUpdate>;
  close(): void;
}

type FileChange =
  | { kind: "changed"; path: string }   // root-relative, always
  | { kind: "added"; path: string }
  | { kind: "deleted"; path: string };

interface ExtractedUpdate {
  /** Re-extracted files. A file absent here keeps the entry the store holds. */
  readonly files: readonly ExtractedFile[];
  /** Files deleted from the project. Not "stopped contributing" — a file that
   *  declares nothing still has an `ExtractedModule` and still has import edges. */
  readonly removed: readonly string[];
  /** True when `files` is the whole project and the store is replaced, not patched. */
  readonly full: boolean;
}
```

`ExtractedFile` is left exactly as it is, and so is `files`. What the store needs
that does not exist yet goes in a sibling record — one per source file under the
root, whether or not it contributed a function:

```ts
interface ExtractedModule {
  readonly filePath: string;                                           // root-relative
  readonly imports: readonly string[];                                 // in-root import targets, root-relative
  readonly skippedFunctions: ReadonlyMap<SkippedFunctionKind, number>; // this file's share
  readonly uncarriedContracts: readonly UncarriedContract[];           // this file's share
}

interface ExtractedProject {
  // existing fields, unchanged
  readonly modules: readonly ExtractedModule[];
}
```

All of it is strings and numbers, so the §3.4 boundary is unaffected. **Every
source file under the root gets an `ExtractedModule`, including one that declares
nothing.** A barrel that only re-exports has no function and no runtime wrapper,
so it is absent from `files` — and a store built from `files` alone would hold no
import edge for it, so editing it would invalidate nothing and every importer
would keep a stale resolution. The entry exists for its `imports`; whether the
file contributes anything else is a separate question.

`ExtractedProject.skippedFunctions` and `uncarriedContracts` stay where they are
and keep being what the cold path reads, so `analyze()`, `computeCoverage` and
`filesAnalyzed` are untouched and no existing test moves. The resident store
re-sums them from `modules` instead. **`check src --coverage` reading the same
numbers as before is the acceptance test for this step.**

## What the store keeps, and what dies with the snapshot

Kept — all of it Ambit's own representation, none of it snapshot-bound:

```ts
interface ResidentStore {
  readonly rootDir: string;
  readonly engine: { name: string; version: string };
  generation: number;
  fingerprint: ProjectFingerprint;
  files: Map<string, FileEntry>;               // keyed by root-relative path
  state: Map<SymbolId, PropagatedFunction>;    // the last committed fixed point
  reverseImports: Map<string, Set<string>>;    // imported file → importing files
  reverseCalls: Map<SymbolId, Set<SymbolId>>;  // callee → callers
}

interface FileEntry {
  readonly order: number;                      // only if phase 0 leaves any output order-dependent
  readonly extracted: ExtractedFile;
  readonly summaries: readonly FunctionSummary[];
  readonly matchedConfigKeys: readonly string[];
}

interface ProjectFingerprint {
  readonly engineName: string;
  readonly engineVersion: string;
  readonly tsconfigPath: string | undefined;
  readonly tsconfigHash: string;    // the tsconfig text and its `extends` chain, plus the resolved
                                    // options WITHOUT `fileNames` — see below
  readonly configHash: string;      // ambit.config.ts source text
  readonly resolutionHash: string;  // package.json / lockfile texts
}
```

`tsconfigHash` deliberately excludes `parsed.fileNames`. With `include` globs
that list changes whenever any file appears or disappears on disk, and hashing it
would turn every add and delete into a full rebuild — which is the one thing
§6.2's table says an add or delete is not. The `rootNames` delta is taken
separately and turned into `added` / `deleted` `FileChange`s. An edit to the
tsconfig's own `include` still changes its text, and still forces the rebuild.

Discarded with every generation:

- Every `ts.*` value. The existing rule — only `legacy-ts.ts` may hold one — is
  what makes this automatic, and the resident layer must not become the place it
  is weakened.
- **Pass 1's `Map<ts.Node, SymbolId>`. This is the sharpest edge in the design.**
  Looking an old node up in a new program's map does not throw; it misses, and a
  miss reads as "unresolved", which is a violation quietly becoming an `unknown`.
  The map is rebuilt for the whole project every generation even when one file is
  re-extracted, because a call in the re-extracted file can resolve into a
  declaration in any other. Rebuilding it is a syntactic walk with no checker in
  it, which is why this is affordable.
- **`ResolvedConfig`.** It accumulates `matchedKeys`, so it is rebuilt per
  generation, and `unmatchedExactKeys()` is *not* used on this path: the store
  unions `FileEntry.matchedConfigKeys` across every file and subtracts that from
  the config's exact keys.

## Two reverse graphs, never merged

| Graph | Edge | Decides | Source |
|---|---|---|---|
| Reverse imports | file → files importing it | which files are **re-extracted** | `ExtractedFile.imports`, inverted |
| Reverse calls | `SymbolId` → functions calling it | which functions are **re-propagated** | summaries' `calls` where `kind === "resolved"`, inverted |

Re-extraction follows imports because a change to what a module *exports* changes
how its importers' calls resolve. Propagation follows calls because effects and
capabilities flow backwards along them — that is what §6.2's "walk the contract
dependencies backwards" names. A single graph would be wrong in both directions.

Both graphs are derived, and a re-extracted file's old edges are **removed
before** its new ones are added. Adding without removing is the shape that leaves
a stale caller in `reverseCalls` forever, and it reads as extra work rather than
as a wrong answer, which is why it survives review.

The re-extraction closure is **transitive importers**, taken conservatively: any
text change to a file re-extracts its whole reverse-import closure. The narrowing
that is available — a JSDoc-only change cannot affect an importer's extraction,
because pass 2 never reads a callee's JSDoc — is deliberately *not* taken in the
first implementation. §6.2 forbids under-invalidating on a contract comment and
says nothing against over-invalidating, and the narrowing should be bought with a
benchmark, not with an argument.

## The update lifecycle

One generation of `session.update(changes)`. The phase names are §6.2's.

1. **Fingerprint check** (inside `project-update`). Rebuild `ProjectFingerprint`
   and compare. Any difference, or a change touching a `.d.ts`, a global
   augmentation, or a non-module file, switches to a **full rebuild**: drop the
   store and run the first-check path. Full rebuild shares no code with the
   incremental path, so a bug in one cannot hide in the other.
2. **`project-update`**. `TsProjectSession.update(changes)`. The legacy backend
   rebuilds its program with `oldProgram` and re-extracts the changed files plus
   their reverse-import closure. **The store's `reverseImports` is authoritative
   for that closure**, not whatever the compiler decided to re-resolve.
3. **`extraction`**. Pass 1 over the whole project (syntactic), pass 2 over the
   closure only.
4. **`summarize`**. `summarizeExtractedFiles` per re-extracted file. On a config
   change, every file — extraction is not redone, because no contract in the
   config can change how a call resolves. Each file's `matchedConfigKeys` is
   recomputed.
5. **`impact`**. Below.
6. **`propagate`**. Below.
7. **`report`**. `diagnose`, `buildAuthorityRecords`, `computeCoverage` over the
   whole state. Deliberately not incremental (ADR-0014).
8. **Commit**. Only if every phase above completed. A throw anywhere leaves the
   store byte-identical to the previous generation and is reported as a failure
   (§6.2, §3.4).
9. **`transfer`**. Always 0 in-process, always reported, so a process-separated
   backend fills the same schema.

## Impact and the fixed point

**The changed-summary set `S`.** Compare the new `FunctionSummary` for every
re-extracted, added, or deleted file against the previous generation's,
structurally — including the order of `calls` and the partitioning of `bodies`.
An id that appeared, disappeared, or changed is in `S`. On a config change, every
file is re-summarized and the same comparison runs: adding an effect alias no
function uses puts nothing in `S` and propagates nothing.

**The impact set `I`** is `S` closed under callers:

```
I = S ∪ { f | f reaches some element of S through the reverse call graph }
```

taken over the **union of the old and new reverse call graphs** — a caller that
*lost* an edge to a changed callee has to be recomputed too. The closure is a BFS
with a visited set, so a cycle costs nothing.

**The fixed point.** Reset every `f ∈ I` to what `propagate` initializes with
(`observed = directEffects(f)`, `required` empty, witnesses empty), drop deleted
ids from `state`, and iterate `I` until neither `observed` nor `required` moves.
Callees outside `I` are read at their committed values. Then run the per-body
derivation once, after the fixed point, for the elements of `I` owning two or
more bodies — the same order `propagate` uses.

**Why it terminates.** Values outside `I` are fixed; values inside only grow
under union; the effect set is finite and the capability set is drawn from the
finite set of strings the summaries hold. This is `propagate`'s own argument,
restricted.

**Why it equals a cold run.** A function's propagated value depends only on its
own summary and the values of the callees it resolves. A function outside `I`
has, by construction, no callee whose value changed, so its value is unchanged.
Inside `I`, a least fixed point with the boundary held at those unchanged values
is the restriction of the whole-tree least fixed point. The witness maps follow,
because the terminating pass re-derives them against final values and they are a
function of those values alone.

**That argument is a claim until a test says otherwise**, which is what the
differential suite below is for.

## §6.2's invalidation table, in implementation terms

| §6.2 row | Implementation |
|---|---|
| A file's text, JSDoc included | Re-extract its reverse-import closure |
| Added / deleted | Same closure; a deleted file's ids go into `S` and leave `state` |
| Renamed | A delete and an add. **The resident path makes no rename guess** — `ambit diff` reconciles identity across a rename, from git, and only there |
| `.d.ts`, global augmentation, non-module file | Full rebuild |
| A file in the program but outside the checked root | Full rebuild. Extraction is filtered to files under the root, so no import edge exists to close over, and the file can still change what names inside the root resolve to |
| `ambit.config.ts` | Re-summarize every file; extraction untouched |
| `tsconfig.json`, compiler options | Full rebuild |
| Module resolution | Full rebuild |
| Engine name/version, bundled stubs | Full rebuild |

Stubs force a full rebuild because `legacy-ts.ts` imports `constructorStubKey`,
`isMutatingBuiltin`, and `isFirstArgumentMutator`: the stub tables take part in
*extraction*, not only in summarization. A future `stubs` key in
`ambit.config.ts` inherits that, and belongs in `docs/open-questions.md` when it
is proposed.

## Adversarial cases

Each is a row in the differential suite, not a paragraph of reassurance.

| Case | Expected |
|---|---|
| File deleted | Its ids vanish; callers fall to `unresolved`. Equal to cold |
| File renamed | Every old id gone, every new id new. No `moved` verdict here |
| An export added or removed | Importers re-extract; resolution changes propagate |
| A re-export / barrel re-pointed | Every importer of the barrel is in the closure — including when the barrel declares no function of its own |
| Cycles, self-recursion | `I` containing a cycle still settles, equal to cold |
| An overload implementation swapped | Only the implementation is extracted; the id does not move |
| A callback edge added or removed | `callbackTargets` changes the summary, so it enters `S` |
| The inline-callback owner gaining or losing a body | `bodies` changes the summary; the per-body derivation reruns |
| A JSDoc-only edit | The summary changes and propagates backwards — §6.2's explicit requirement |
| `@boundary` added or removed | `boundaryState` starts or stops cutting the body off |
| A config key added or removed | Every file re-summarized; `unmatchedExactKeys` correct from the union |
| A `paths` change in tsconfig | Full rebuild |
| A dependency installed or updated | Full rebuild |
| Two declarations colliding on one id (§4.1) | Extraction throws; no generation is committed; reported as a failure |
| A mid-edit syntax error | Extraction still runs (the compiler recovers); the answer changes and still equals cold |
| A broken tsconfig | The full rebuild throws; the previous generation stays; reported as a failure |

## Testing

- **Differential equivalence, the centre of the suite.** Apply a mutation, call
  `update`, compare the whole result — diagnostics, authority records, coverage —
  against a cold `analyze()` over the same tree. The mutations are
  `scripts/m05-probe/mutations.ts` (the gate-3 set) plus every row above.
- **Chains.** Ten mutations against one session, compared after each. A single
  update cannot catch state that survives into a third generation.
- **Revert.** Change and change back. Authority *decreasing* is the non-monotonic
  direction and is where a reset-based fixed point earns its keep.
- **Failure.** For each of a broken tsconfig, a broken config, and an id
  collision: the update throws, the previous generation's diagnostics are not
  returned, and the next valid update succeeds.
- **Self-hosting.** Open a session on `src/`, touch one real file, compare
  against cold. Fixtures do not have the shapes this repository has — the same
  reason `test/backend.legacy-ts.test.ts` asserts against `src/` directly.
- **No existing test changes.** If one has to, the design is wrong.

The gate-3 scenario ADR-0001 held against the native backend — a contract comment
rewritten, a stale answer returned with no error — is the headline case. A
resident path that reintroduces it has failed whatever else it achieves.

## Benchmark

`scripts/bench-resident.ts`, outside `pnpm test` and outside `tsconfig.json`'s
`include`, like every other script.

- Subjects: `src` (40 files), `test/fixtures/realistic-api`, and one repository
  already pinned in `test/corpus/corpus.json`.
- Measured: every phase of the first check, every phase of a one-file re-check,
  each of ten consecutive updates, peak RSS.
- The baseline is **calling `analyze()` every time** — ADR-0014's architecture A.
  "Faster" is said against that baseline and against nothing else.
- Results go to `docs/measurements/` with a date, and the two rows they bear on
  in `docs/status.md`. No predicted number is written anywhere.
- This is the prerequisite for re-running §3.5's gates 3 and 4 on the product,
  which ADR-0001 lists as a revisit condition. Re-running them is not part of
  this work.

## Build order

| Phase | Content | Done when |
|---|---|---|
| 0 | Canonical diagnostic ordering, independent of file discovery order; one sentence in §5.1 | `check src --format json` is byte-identical across runs; existing tests pass |
| 1 | `ExtractedFile` gains `imports` / `skippedFunctions` / `uncarriedContracts`; `ExtractedProject`'s aggregates become derivations | `check src --coverage` counts unchanged |
| 2 | `resident.ts` with the store and a full-rebuild-only `update` (architecture A) | The differential suite passes on every mutation — slowly is fine |
| 3 | The scoped fixed point in `propagate.ts`; extraction still whole-project | Suite still passes; `impact` appears in the timings |
| 4 | `openProject` in the legacy backend; reverse-import closure re-extraction | Suite still passes; `extraction` shrinks |
| 5 | Benchmark, `docs/measurements/`, `docs/status.md` | Measured numbers exist |
| 6 | CLI exposure — separate work, separate `CHANGELOG.md` entry | — |

Phase 2 building a resident session that recomputes everything is the point of
the order: the equivalence suite goes green before any speed change lands, so the
first update that breaks equality names itself.

## Undecided

- Phase 0 may change the order of today's one-shot diagnostic output. §9.2 lists
  the NDJSON *field shape*, not record order, so no announcement is owed — but a
  `CHANGELOG.md` line is cheaper than the question. Measure the actual change
  first.
- Where the change set comes from — an editor's notifications, a file watcher —
  is not decided here, and is not needed: the tests and the benchmark apply their
  own changes. It belongs with CLI exposure in phase 6.
- What `resolutionHash` has to cover. `package.json` and the lockfile may not be
  enough in a workspace; verify against a corpus repository that has one, and if
  it is not enough, widen the full-rebuild trigger rather than narrow it.
