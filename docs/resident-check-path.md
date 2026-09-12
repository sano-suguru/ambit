# The resident check path

How `docs/DESIGN.md` §6.2 is to be built, for whoever builds it. §6.2 is the
specification and wins any disagreement with this file; the reasoning behind the
architecture is [ADR-0014](adr/0014-the-resident-check-path.md). Nothing here is
a new guarantee — §9.2 puts the existence of a resident path outside the
guaranteed surface, and this document adds no claim to it.

Status: **phases 0–2 implemented, phases 3–6 not.** `docs/status.md` carries
what that means in detail; this file stays the design, and where the
implementation forced a correction the text below says so rather than being
quietly left behind.

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
| `src/checker/report.ts` | New. The `report` phase — diagnostics, authority records, coverage — composed once and called by both paths (correction 8) |
| `src/cli/analyze.ts` | Delegates the `report` phase to `report.ts`; otherwise unchanged. The cold path is what the resident path is tested against |

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
  /** One per re-extracted source file, including files absent from `files`. */
  readonly modules: readonly ExtractedModule[];
  /** Files deleted from the project. Not "stopped contributing" — a file that
   *  declares nothing still has an `ExtractedModule` and still has import edges. */
  readonly removed: readonly string[];
  /** True when `files` is the whole project and the store is replaced, not patched. */
  readonly full: boolean;
  /** Absent where the backend cannot separate project construction from extraction. */
  readonly projectUpdateMs?: number;
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
  readonly module: ExtractedModule;
  readonly extracted?: ExtractedFile;          // absent for a file that declares nothing
  readonly summaries: readonly FunctionSummary[];
  readonly matchedConfigKeys: readonly string[];  // phase 3 — see correction 3
}

interface ProjectFingerprint {
  readonly engineName: string;
  readonly engineVersion: string;
  readonly tsconfigPath: string | undefined;
  readonly tsconfigHash: string;    // the tsconfig text. The `extends` chain and the resolved
                                    // options WITHOUT `fileNames` are phase 4's — see below
  readonly configHash: string;      // ambit.config.ts source text
  readonly resolutionHash: string;  // package.json / lockfile texts
  readonly undecidable: readonly string[];  // non-empty means rebuild, whatever the rest says
}
```

**What the fingerprint cannot decide, it rebuilds.** The fingerprint is not
trying to be a complete model of what a project depends on; it is trying to be a
cheap test that is never wrong in the permissive direction. Anything it cannot
answer — a lockfile shape it does not know, a workspace manifest it has not seen,
a `node_modules` tree rewritten from outside — is a full rebuild, and widening a
trigger is always the allowed move while narrowing one needs evidence.

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
  generation. From phase 3 on, `unmatchedExactKeys()` is *not* usable on this
  path — the store must union `FileEntry.matchedConfigKeys` across every file
  and subtract that from the config's exact keys, which needs `contractFor` to
  report which key it matched (correction 3). While every update is a full
  rebuild, `unmatchedExactKeys()` is read after a whole run and is correct.
- **Node's ESM module cache, for the config and everything it imports.**
  `loadConfig` imports `ambit.config.ts`, and `import()` caches by URL for the
  life of the process, so an edited config would come back as its previous
  version. A config that imports nothing is re-imported under a query carrying
  its own content hash; one that imports anything is evaluated in a worker
  thread, whose module registry is its own — a content query on the config
  alone re-evaluates the config out of cached dependencies. `configHash` covers
  the same closure (correction 7).

## Two reverse graphs, never merged

| Graph | Edge | Decides | Source |
|---|---|---|---|
| Reverse imports | file → files importing it | which files are **re-extracted** | `ExtractedFile.imports`, inverted |
| Reverse calls | `SymbolId` → functions calling it | which functions are **re-propagated** | summaries' `calls` where `kind === "resolved"`, inverted |

Re-extraction follows imports because a change to what a module *exports* changes
how its importers' calls resolve. Propagation follows calls because effects and
capabilities flow backwards along them — that is what §6.2's "walk the contract
dependencies backwards" names. A single graph would be wrong in both directions.

**A closure over the edges already held cannot find what a *new* file changes.**
The edges are resolved import targets, so a specifier that resolved to nothing —
`import { x } from "./foo"` with no `foo.ts` in the tree — held no edge at all,
and the file it would point at does not exist to close over. Adding `foo.ts`
therefore leaves its importer unvisited, its call still `unresolved`, and the
resident answer quietly behind the cold one. TypeScript's resolution precedence
makes the same point more sharply: a new `foo.ts` can take a specifier away from
an existing `foo/index.ts`, and the importer's edge pointed at the file that
*keeps* resolving, not at the one that arrived. **So a file addition is a full
re-extraction, not a closure** — and a rename, being a delete and an add, is one
too.

Deletion is the asymmetric case and is genuinely safe: every file whose
resolution a deletion can change had a specifier resolving *to* the deleted file,
which is exactly an edge the old graph holds. Removing a candidate cannot
redirect a specifier that was resolving elsewhere.

The narrowing that would make an addition incremental is an index from
*unresolved specifier* to the files that wrote it, plus the resolution candidates
each specifier could have taken. It is worth building when a benchmark says
additions are frequent enough to matter, and it is not worth building first: it
is a second resolution model living beside the compiler's, and a second model is
a second way to be wrong.

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
   and compare. Any difference, an `added` change, or a change touching a
   `.d.ts`, a global augmentation, or a non-module file, switches to a **full
   rebuild**: drop the
   store and run the first-check path. Full rebuild shares no code with the
   incremental path, so a bug in one cannot hide in the other.

   **What the verdict gates is extraction, and that makes it phase 4's, not
   phase 3's.** The distinction matters because `undecidable` carries a
   permanent entry — the resolved compiler options, which nothing can read
   until `openProject` exists — so reuse is refused on every update until
   phase 4. A phase 3 written *inside* the permitting branch would therefore
   never run, and could not be measured.

   It does not have to be, and **the reason is not that a refused fingerprint
   makes every summary count as changed** — it does not. A compiler option can
   differ while a given function still extracts, resolves and summarizes to
   exactly what it did before, and that function belongs in neither `S` nor
   `I`.

   Phase 3 is independent because it **reuses no compiler or extraction result
   at all**. It re-extracts and re-summarizes the whole project from the new
   snapshot, then compares those Ambit-owned summaries against the previous
   generation's. Only a summary whose propagation inputs actually moved enters
   `S`; a summary that did not move needs no invalidation merely because the
   project fingerprint refused compiler-level reuse. That is also where the
   value is: a tsconfig edit that changes nothing semantic gives `S = ∅` and
   costs one extraction, not one whole fixed point. Phase 4 is where the
   fingerprint begins gating extraction reuse.
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

## Who has to notice a change

The *transport* — an editor's notifications, a file watcher, a test driving the
session by hand — is phase 6 and is genuinely open. The *responsibility* is not,
because it decides whether an invalidation rule can fire at all: a rule that says
"a change outside the root is a full rebuild" is inert if nothing outside the
root is ever reported.

The split is this. **The session does not trust its caller to report everything.**
`FileChange` carries what the caller knows about files under the root, and every
update independently recomputes `ProjectFingerprint` — the tsconfig text and its
`extends` chain, `ambit.config.ts`, and the resolution inputs — from disk before
doing anything else. So a change to a `.d.ts` outside the root, an installed
dependency, or a tsconfig nobody told the session about is caught by the
fingerprint at the top of the next update, not missed. What the caller owes is
only the in-root change set, and a caller that over-reports costs time rather
than correctness.

That leaves one honest gap, and it is stated rather than closed: a change to a
file **under the root** that the caller never reports is invisible until
something else triggers a rebuild. Phase 5's benchmark and the self-hosting test
both drive the session with a known change set, so neither depends on the gap
being closed; a watcher does, and that is phase 6's problem to solve rather than
to discover.

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

**What the comparison has to cover, and the risk if it does not.** `S` is
decided by one equality test over `FunctionSummary`, so *that comparator* is
where phase 3 can go wrong — not the fingerprint. If any field a propagated
value depends on is left out of it, an unchanged verdict is returned for a
summary whose inputs moved, the function never enters `I`, and its committed
value is reused while being stale. The fields that must be in it, from
`src/core/summary.ts`: `declared`, `capabilities`, `budget`, `boundary`,
`entrypoint`, `calls` **in order** — including each call's `kind` and, per
kind, `callee` / `effects` / `requiredCapability` / `capabilityTargetUnknown` /
`reason` / `escaping` / `unknownCallback` — and the partitioning of `bodies`.
`location` and `tagLocations` are in it too, because a diagnostic's reported
position is part of the bytes §6.2 compares. The honest default for a field
nobody has reasoned about is *included*: an over-wide comparator costs a
recomputation, and a narrow one costs a wrong answer. The differential suite is
what has to catch a gap here, which is why every phase 3 row is added to it
before the narrowing it justifies.

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
| Deleted | Same closure; the file's ids go into `S` and leave `state`. Safe for the reason above |
| Added | **Full re-extraction.** No closure over the edges already held can find the importers a new file changes |
| Renamed | A delete and an add, so a full re-extraction. **The resident path makes no rename guess** — `ambit diff` reconciles identity across a rename, from git, and only there |
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
| **An unresolved import, then the file it names is added** | The importer's call stops being `unresolved` and resolves, and its caller's effects change with it. This is the case a closure over held edges cannot reach, and the reason an addition is a full re-extraction |
| A new file taking a specifier from an existing one (`foo.ts` added beside `foo/index.ts`) | The importer re-resolves to the new file. Same reason, same handling |
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
| 1 | `ExtractedProject` gains `modules` — see **Components**, not `ExtractedFile`, and the aggregates stay where they are | `check src --coverage` counts unchanged |
| 2 | `resident.ts` with the store and a full-rebuild-only `update` (architecture A) | The differential suite passes on every mutation — slowly is fine |

Phases 0, 1, 2 and 3 are done. What building them corrected is recorded under
**Corrections from the implementation** below.
| 3 | The scoped fixed point in `propagate.ts`; extraction still whole-project. **Not gated on `fingerprintPermitsReuse`** — see the lifecycle's step 1 | Suite still passes; `impact` appears in the timings |
| 4 | `openProject` in the legacy backend; reverse-import closure re-extraction | Suite still passes; `extraction` shrinks |
| 5 | Benchmark, `docs/measurements/`, `docs/status.md` | Measured numbers exist |
| 6 | CLI exposure — separate work, separate `CHANGELOG.md` entry | — |

Phase 2 building a resident session that recomputes everything is the point of
the order: the equivalence suite goes green before any speed change lands, so the
first update that breaks equality names itself.


## Corrections from the implementation

Written when phases 0–2 landed. Each is a place the design above was wrong or
under-specified; the design has been edited in place and this list says what
changed, so a reader of an earlier draft is not left with a stale picture.

1. **Phase 0 canonicalized more than diagnostics.** `skippedByKind` and
   `unresolvedByReason` reach the output through `Object.fromEntries` and
   through the text formatter, both of which serialize a `Map`'s insertion
   order — which is the order files were walked. So are
   `fixes[].impact.callersAffected`, which came from iterating the propagated
   state. All three are now ordered by a key of the finding. Without it the
   resident path, re-summing the counts from per-file slices, would have had to
   reproduce a walk order to be byte-equal.
   The order `check src --format json` prints **did** change, so a
   `CHANGELOG.md` line was owed after all — the "Undecided" entry above is
   settled.

2. **`FileEntry.order` is not needed.** The design made it conditional on phase
   0 leaving something order-dependent. Nothing is, so the field does not
   exist.

3. **`FileEntry.matchedConfigKeys` was deferred to phase 3, and phase 3 built
   it.** `ResolvedConfig.contractFor` now returns a `ConfigMatch`
   (`{ contract, exactKey? }`) and `ResolvedConfig` gained `exactKeys()`;
   `summarizeFiles` reports the keys each file matched beside its summaries,
   and the store's `unmatchedExactKeys` is `exactKeys()` minus the union over
   the files, in the config's own key order. `unmatchedExactKeys()` stays on
   `ResolvedConfig` for the cold path, which does look every symbol up through
   one object. A glob match carries no `exactKey`: a glob matching nothing is
   never reported, so there would be nothing to subtract.

4. **`FileEntry.extracted` is optional.** A file that declares no function and
   registers no runtime wrapper has no `ExtractedFile` at all — which is the
   barrel case the `ExtractedModule` record exists for. The design's own
   argument required this; its type signature did not say so.

5. **`ProjectFingerprint` gains `undecidable: readonly string[]`.** The design
   said "what the fingerprint cannot decide, it rebuilds" and then wrote a
   record of hashes with nowhere to put "I do not know". The list is that place,
   and a non-empty list means rebuild whatever every other field says. Two
   entries are populated today: a `tsconfig.json` with an `extends` chain, and —
   always — the resolved compiler options, which are not reachable without a
   backend session. **The second is removed by phase 4's `openProject`**, and
   until it is, every fingerprint comparison refuses reuse, which is the correct
   answer for a phase that rebuilds anyway.

6. **`ExtractedUpdate` carries `modules` and an optional `projectUpdateMs`.**
   The store needs one module record per re-extracted file, not only the files
   that declared something; and §6.2 asks for `project-update` and `extraction`
   to be measured separately, which a backend reached only through
   `extractProject` cannot do. The adapter leaves the field absent rather than
   reporting 0 — absent means "not separable by this backend", 0 would mean
   "free", and §3.4's distinction between the two is the whole point.

7. **`loadConfig` had to stop trusting Node's ESM module cache — twice.**
   `import()` caches by URL for the life of the process, so a second
   `loadConfig` on an edited `ambit.config.ts` returned the *first* version's
   exports. One-shot `ambit check` never noticed; a resident session is exactly
   the process that loads the config again after it changed, and §6.2's table
   requires that change to re-derive every contract.

   The first fix put the config's own content hash in the specifier's query.
   That is correct for a config whose value is a function of its own text, and
   **wrong for one that imports anything**: the config is re-evaluated, but its
   `import "./contracts.ts"` resolves to the same URL as last time, so Node
   hands it the cached module and the config is rebuilt out of stale parts. The
   query cannot be pushed down either — the specifier is written in the
   config's source, not chosen by the loader. Reproduced before it was fixed.

   Two consequences, and they are separable:

   - **The value.** A config that imports anything is now evaluated in a worker
     thread, which has a module registry of its own, so its whole graph is
     fresh. A config that imports nothing keeps the content-query path and pays
     nothing. The cost is one worker start, and it buys the only behaviour §6.2
     accepts. `AmbitConfig` is plain data, so it crosses the thread boundary by
     structured clone.

     **"Imports anything" is its own question, and deriving it from the hash
     closure was wrong.** The first attempt used `files.length > 1`, which is
     the count of *relative* specifiers that resolved — so a config importing
     only `ambit-ts/config`, and a config whose relative import was written
     across several lines, both produced a one-element closure and took the path
     that cannot see an edited dependency. Both were reproduced. The load
     decision is now `ConfigDependencies.hasImports`, which is set by any static
     `import` or `export … from`, bare or relative, however it is written, and
     the scanner no longer stops at the first newline. A shape it still cannot
     read a specifier out of is counted and reported as `undecidable` rather
     than passed over — the scan is allowed to see an import that is not there,
     and never allowed to miss one that is.

     What this does *not* close: a package rewritten in place changes neither
     `configHash` (bare specifiers are not in the closure, by design) nor
     `resolutionHash` (the lockfile did not move). The config is still
     *evaluated* fresh, so the answer is right; it is the fingerprint's reuse
     decision that would be wrong, and it is covered only because
     `undecidable` is permanently non-empty until phase 4. **Phase 4 must not
     remove that entry without answering this**, which is why it is written
     here rather than left to be rediscovered.
   - **The fingerprint.** `configHash` now covers the config *and the
     transitive closure of its relative imports*, not the config's text alone.
     A bare specifier is not followed: it names a package, and a change there is
     a resolution change, which `resolutionHash` and §6.2's table already answer
     with a whole rebuild. Anything the closure walk cannot decide — a specifier
     resolving to no file, a dynamic import — goes into `undecidable`, because
     an incomplete closure makes an unchanged hash meaningless.

   **This also changed what the equivalence oracle proves.** Both paths call the
   same `loadConfig` in the same process, so a stale config made the resident
   session and the in-process cold run agree byte for byte on the same wrong
   answer — a comparison certifying a defect rather than catching it. The config
   rows are therefore also compared against a cold run in a **separate
   process** (`test/support/cold-oracle.ts`), which shares no module registry
   with the session. Both new tests were confirmed to fail without the fix.

   One honest consequence is recorded rather than hidden: starting a thread is
   authority, so `analyze`, `openResidentSession` and the update path declare
   `process` where they declared only `fs_read`. Ambit reported the increase
   against its own source, which is what it is for.

8. **The report phase is one function shared by both paths.**
   `src/checker/report.ts` composes the diagnostics, the authority records and
   the coverage report, and `analyze()` and the resident session both call it.
   The design's table said `analyze.ts` was unchanged; it moved instead, and the
   reason is the equivalence law — two compositions of the same diagnostics are
   two orders to keep in step, and the first divergence between them would read
   as an analysis difference rather than a reporting one.

9. **A line-shifting edit puts every later declaration in the file into `S`.**
   `location` is compared, because a diagnostic's reported position is part of
   the bytes §6.2 compares, so inserting or deleting a line moves every
   function below it and each of them is "changed". This is the comparator
   being conservative in the direction it is allowed to be wrong in — it costs
   a recomputation, never an answer — and the differential suite asserts it
   rather than working around it. Narrowing it would mean separating "the
   summary moved" from "the summary is at a different place", which is a real
   design question and not a small one: the second still has to reach the
   report. Not attempted; recorded so the next reader does not mistake the
   wide `S` for a defect.

10. **The old/new reverse-graph union is a second reason, not the only one.**
    With `S` decided by `summariesEqual`, a caller that lost an edge to a
    changed callee is in `S` by construction — its `calls` array lost an
    entry, or its callee vanished and the call fell to `unresolved` — so on
    that argument the union adds nothing. Whether any *measured* case needs it
    was not established either way, and the union is implemented and tested
    anyway (`test/impact.test.ts`, "reaches a caller that exists
    only in the old graph"), because it is the half of the argument that does
    not depend on the comparator being complete, and it costs one map lookup
    per visited node.

11. **`propagateScoped` holds the *new* summary object on a reused value.** A
    symbol outside `I` keeps its committed `observed`, `required`, witnesses
    and per-body split, but its `PropagatedFunction.summary` is replaced with
    the new generation's object. The two are interchangeable by
    `summariesEqual` — that is what put the symbol outside `I` — so this
    changes nothing that the comparator covers. What it buys is that a field
    the comparator does *not* cover cannot reach the report stale either: only
    the lattice values are reused, never the description. A symbol outside `I`
    with no committed value throws rather than falling back to an initial one,
    because an un-propagated function in the output would read as a function
    that was analyzed and found clean (§3.4).

## What phase 3 found and left for phase 4

- **`fingerprintPermitsReuse` is still computed and still unused.** Phase 3 is
  outside it by design (lifecycle step 1) and phase 4 is where it starts
  gating extraction. Its `undecidable` list is still permanently non-empty.
- **`ExtractedUpdate.full === false` still throws.** Nothing patches the store
  yet; the scoped fixed point reuses propagated values, never extraction
  results. Phase 4 is what makes a partial update committable, and the
  invalidation table above is what it has to implement.
- **The per-file `matchedConfigKeys` is built and is not yet load-bearing.**
  Every generation still summarizes every file, so the union it is subtracted
  from is a whole-project union. It becomes load-bearing the first time phase
  4 re-summarizes a subset.

## Undecided

- ~~Phase 0 may change the order of today's one-shot diagnostic output.~~
  **Settled.** It did change `check src --format json`'s order, and a
  `CHANGELOG.md` line was written for it. See correction 1.
- Where the change set comes from — an editor's notifications, a file watcher —
  is not decided here, and is not needed: the tests and the benchmark apply their
  own changes. It belongs with CLI exposure in phase 6.
- What `resolutionHash` has to cover. `package.json` and the lockfile may not be
  enough in a workspace; verify against a corpus repository that has one, and if
  it is not enough, widen the full-rebuild trigger rather than narrow it. The
  rule above already says which way to fail.
- Whether file additions are frequent enough in a real editor session to be worth
  the unresolved-specifier index that would make them incremental. Measured in
  phase 5, not guessed at before it.
