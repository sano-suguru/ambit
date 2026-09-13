# Outside-root edits: a candidate condition for skipping the whole rebuild

Run on 2026-09-13, Node.js v24.20.0, TypeScript 6.0.3 (`typescript-legacy`),
macOS (darwin arm64), Apple M1 — the machine of
[the workload observation](2026-09-13-resident-workload.md). A design
investigation: nothing in `src/` or `test/` changed, and nothing here is built.
The probes were throwaway scripts outside the repository and are not committed.

**Question.** A file F is in the tsconfig project but outside the checked root
(`test/*.ts` under `check src`). §6.2 rebuilds everything when F changes. Under
what conditions is every in-root extraction — and so the cold `analyze()`
bytes — the same before and after an edit to F, and can that be proved?

**Answer.** Not proved yet. A candidate sufficient condition survived 36
adversarial probes, has a proof sketch, and is cheap to check. The obvious
version of it is unsound. "No in-root file imports F" (directly or transitively) admitted
three edits that changed in-root output (cases 34–36 below). The version that
survives also treats every file that contributes to the global scope as a root
of the reachability walk.

## 1. How a file outside the root reaches an in-root answer

An in-root answer is what `extractFromProgram` reads from the checker for an
in-root file, plus Ambit's own in-root-only bookkeeping. It can depend on
another file through five channels:

| | Channel | Forms |
|---|---|---|
| a | **Resolved module edges** | `import` / `export … from`, `import =`, dynamic `import()`, `import("…")` type nodes, `/// <reference path>`, `/// <reference types>`, implicit JSX / helper imports, `paths` / `baseUrl` aliases — followed transitively, through barrels and through type-only edges |
| b | **The global symbol table** | a script (a file the compiler does not treat as a module), `declare global`, ambient `declare module "x"`, module augmentation `declare module "./m"`, `export as namespace` (UMD), the lib files, `types` / `typeRoots` packages. None of these needs an edge from the file that reads them |
| c | **Program structure** | which files are in the program, and `getSourceFiles()` order. F's own imports and references can add files (`/// <reference lib>`, an import of a global module); F can be processed before an in-root file that is not yet loaded and fix that file's `fileName` spelling or position |
| d | **Compiler options** | already a §6.2 whole-rebuild row |
| e | **Module resolution** | file *existence*, `package.json` / `exports` / `typesVersions`, symlinks. Resolution depends on the file system and options, not on the target file's text — except through a symlink, where "F's text" is also an in-root file's text |

Ambit-side, nothing widens this. Pass 1 mints ids over in-root files only; a
symbol id is derived from the in-root relative path and the declaration path;
`collectImportTargets` drops edges that leave the root; no compiler diagnostic
reaches `analyze()`'s output (no `get*Diagnostics` call in `src/`); stubs and
`ambit.config.ts` are other rows (the config's own value hash already catches a
config that imports F). What does not apply: project references (`loadProjectConfig`
never passes them to `createProgram`), automatic type acquisition (a language-service
feature, not a `createProgram` one), JavaScript files (the predicate below excludes F
being one).

## 2. Counterexamples

Each case builds an old and a new tree differing only in F (unless stated), runs
cold `analyze()` and `legacyTsBackend.extractProject` on `src` in both, and
compares the JSON. "Changed" means either differs. Default config: `NodeNext`,
`lib: ["ES2023"]`, `types: []`. Under TypeScript 6 with this config the
compiler reports every file as a module, including one with no `import` or
`export` (probed with `ts.isExternalModule`), so script cases use
`moduleDetection: "legacy"`.

| # | Edit to F | In-root output changed | Channel |
|---|---|---|---|
| 01 | nothing (control) | no | — |
| 02 | test body, F imports `src` | no | — |
| 03 | F adds an import of an in-root file | no | — |
| 04 | exported type shape, no in-root importer | no | — |
| 05 | exported type shape, `src` does `import type` from F | **yes** | a |
| 07 / 33 | same via a barrel in `test/` (value / type-only) | no / **yes** | a, transitive |
| 06 / 25 | `import("…")` type node / `paths` alias into F | no (fixture too weak to show) | a |
| 08 | `export function fetch` → `function fetch`, default detection | no — F stays a module | — |
| 26 | module → script declaring `fetch` (legacy detection) | **yes** | b |
| 09 | adds `declare global { function fetch }` | **yes** | b |
| 29 | script adds ambient `declare module "mailer"` | **yes** | b |
| 30 | adds `declare module "../src/box.ts"` augmentation | **yes** | b |
| 31 | the same augmentation nested in `namespace N` | no (compiler rejects it) | — |
| 18 / 19 | `export as namespace Lib` in a `.d.ts` / in a `.ts` | **yes** / no | b |
| 13 | `interface Array<T>` inside a module | no | — |
| 12 / 32 | `interface Array<T>` in a file the compiler treats as a module / F stops re-exporting `src/b.ts` and declares its own `run` | no / no | — |
| 14 | adds `/// <reference lib="dom" />` | **yes** (lib file enters) | c |
| 15 | adds `/// <reference no-default-lib="true"/>` | no | — |
| 16 / 17 | references a global `.d.ts` / imports a `declare global` module not otherwise in the program | **yes** | c |
| 21 | `.tsx` with `@jsxImportSource` pragma | no | — |
| 22 | include lists `test` first; F imports `src/b.ts` | **yes** — in-root order (extraction only; `analyze()` bytes equal) | c |
| 23 | same include order; F imports `../src/A.ts` (case differs) | **yes** — in-root `fileName` becomes `A.ts`, ids move | c |
| 24 | `src/link.ts` is a symlink to F | **yes** — an in-root text changed | e |
| 34 | a script `test/types.d.ts` declares `helper(): import("./f.ts").Svc`; F changes `Svc` | **yes** | b → a |
| 35 | `test/aug.ts` augments `src/box.ts` with a member typed from F | **yes** | b → a |
| 36 | `test/glob.ts` has `declare global { function helper2(): import("./f.ts").Svc }` | **yes** | b → a |

Additions, deletions and renames of F were not probed: they are §6.2 rows of
their own and outside the subset below.

## 3. Candidate sufficient conditions

These are conservative conditions this candidate imposes, not conditions safety
requires: an edit that fails one — a harmless `.d.ts` edit, say — can still be
safe; it is outside what the candidate covers.

| Condition | Hazard this excludes | Probe cases it rejects | Enough alone |
|---|---|---|---|
| **P1** F is in both programs, is `.ts` / `.mts` / `.cts` / `.tsx`, not a declaration file | an addition, deletion or rename changes channel e; a `.d.ts` can bind `export as namespace`; JavaScript binds globals through expando and CommonJS assignments | 18; §6.2's add/delete rows | no |
| **P2** F contributes nothing global in either generation: a module, with no `declare global`, no string-named `declare module` and no `export as namespace` at any depth | channel b, and *becoming* or *ceasing to be* a contributor is the same hazard | 09, 26, 29, 30 | no — 05 passes it |
| **P3** Same options and root names; the same `getSourceFiles()` sequence of `fileName`s, spelling included; every file other than F has identical text | channels c, d, e: files entering or leaving, order, `fileName` capture, a symlink making an in-root text change without being reported | 14, 16, 17, 22, 23, 24 | no — 05 passes it |
| **P4** F is not reachable over channel a from **in-root files ∪ every file that contributes to the global scope** (every file failing P2's test, lib and `types` files included) | an in-root name can reach F through an import chain, or through a global declaration whose type names F | 05, 33, 34, 35, 36 | no |
| P4′ — reachable from in-root files only | — | 05, 33 | **unsound**: 34, 35, 36 pass it and change output |

**P1 ∧ P2 ∧ P3 ∧ P4**, for every outside-root file whose text moved, is the
candidate condition. Probe result: over the 36 cases it rejected every edit that
changed in-root output and admitted 10 edits, none of which did. It also
rejected 10 edits that changed nothing (06, 07, 10, 11, 19, 20, 25, 27, 28,
31), which costs a rebuild and nothing else.

**The proof sketch.** Under P3, every input except F is identical, so
resolution (e), options (d) and structure (c) are identical. Under P1 ∧ P2, F
adds nothing to the global table in either program, so the global table is
built from identical files (b). Every symbol an in-root checker query can
reach is then in a file reachable over (a) from an in-root file or from a
global contributor; under P4, F is not one of them, so every declaration,
type and resolution the in-root walk reads is built from identical text.
Pass 1 and pass 2 visit the same in-root files in the same order and issue the
same checker queries; nothing else in extraction reads the program.

**What the sketch rests on and has not proved:** that channels a–e are the
whole list — that nothing in `createProgram` or the checker lets a module
with no global contribution influence a query about a file that cannot reach
it. That is a claim about TypeScript 6.0.3's implementation, supported by the
36 probes and by the compiler's structure as described above, not by reading
the checker end to end. Also unproved: whether `getSourceFiles()` order alone
ever changes `analyze()` bytes (case 22 says not there); P3 compares it anyway.

## 4. Candidate designs

- **A — current rule.** Any outside-root project input edit is a whole rebuild.
  Correct, free to decide, and the cost is the measured whole rebuild.
- **B — prove isolation (P1–P4).** The conditions above, checked per generation
  against the new and previous program. The version in the goal — F not
  imported by an in-root file — is P4′ and is refuted by 34–36; B is only viable
  with the global-contributor roots.
- **C — compare in-root facts.** Build the new program, re-extract every in-root
  file, and reuse if nothing moved. It is correct by construction, and its
  cost is the whole rebuild plus a comparison: pass 2 over every in-root file
  *is* the extraction the rebuild does. Rejected on cost, not on correctness.

## 5. The shape B would take

- **The resident layer** offers nothing new. `planUpdate` stops forcing a whole
  rebuild for a reported path it has no entry for, and plans a partial update
  with an empty closure. It checks the backend's answer the way it checks
  `contract-only`: an `outside-root-isolated` answer with a non-empty
  re-extraction set is a throw, and a throw commits nothing.
- **The backend** proves it. The caller need not report F: the backend already
  sees F as an `externalFiles` hash delta. Where today any delta refuses reuse,
  B lets through the deltas whose files all pass P1 ∧ P2 ∧ P4, with P3 over
  everything else.
- **Program facts compared.** Options hash and root names (already); the
  `getSourceFiles()` `fileName` sequence (new — today the in-root key *set* is
  compared); every non-F text (already hashed for external files; in-root texts
  would have to be compared too, which is what closes case 24); per external
  file, a global-contributor flag in both baselines; reachability walked on the
  new program. Reachability on the previous program adds nothing under P3: an
  edge *into* F comes from a file whose text is unchanged.
- **State held across generations.** Strings and booleans only, in
  `ProjectBaseline`: the sequence and the per-file flag. No node, symbol or type
  outlives its program.
- **Public API only.** `sf.imports`, `moduleAugmentations`, `ambientModuleNames`
  and `symbol.globalExports` — used by the probe — are `@internal`. The product
  version walks the AST the way `collectImportTargets` does, without the
  in-root filter, resolves each specifier with
  `program.getResolvedModuleFromModuleSpecifier`, and follows
  `referencedFiles` and `typeReferenceDirectives`; the global-contributor test
  is the probe's AST walk plus `ts.isExternalModule`. Implicit JSX / helper
  imports have no specifier node, so a file with `jsx` other than `preserve`,
  or `importHelpers`, has to be handled by treating their targets as roots or
  by refusing.
- **Fallback.** Any condition failing, any value that cannot be read, an F that
  is not a program input of both generations: the whole rebuild, as today.
- **After the proof.** Pass 1 still runs; nothing is re-extracted; every
  summary is kept; the impact range is empty; `report` runs over the whole state
  as it always does.
- **No growth of the guarantee surface.** §9.2 already puts the resident path
  outside it; nothing here is a flag, a field or a diagnostic.

## 6. Economics — Ambit's own `check src`

`ResidentSession` on this repository (49 in-root files, 692 program files,
46 of them under `test/`), median of 10 after 2 unmeasured, alternating:

| Update | total ms | project-update ms |
|---|---:|---:|
| `update()` — whole rebuild, what an outside-root edit costs today | 659 | 444 |
| `update([])` — partial, empty closure: B's cost after a successful proof | 420 | 415 |

`update([])` stands in for B's success path without the proof itself. The proof,
probed on the same program: the reachability walk from 200 roots (49 in-root,
151 global contributors) reaches 643 files in **5.0 ms**; the external-file
hashing it needs is already paid in `baseline`. Of the 46 `test/` files, 45 are
unreachable and pass P2; the one that is not is `test/support/global-setup.ts`,
which augments `vitest` (`declare module "vitest"`) and would keep its whole rebuild. An edit to
`test/cli.test.ts`, applied through an in-memory host, left the 692-file
sequence identical (with and without `oldProgram`) and no other text changed.

- **Best case per qualifying batch:** 659 − 420 ≈ 240 ms (36%) saved, for ≈ 5 ms
  of proof. Project-update (≈ 415 ms) stays in every row — the same limit
  ADR-0015 records for contract-only narrowing.
- **Against the observed workload:** every pure outside-root batch in the trace
  (`call` 62, `bash` 39) edits `test/` only; git has 20 pure batches and 43
  that also touch `src`. At 240 ms each that is an arithmetic ceiling, not a
  replay, of about 15 s of 97 s (`call`), 9 s of 52 s (`bash`), and 5 s of 54 s
  (git, pure batches only). The 43 mixed git batches would stay whole unless B
  composes with the in-root closure — the same proof with in-root edits planned
  as today — which the design above permits but which was not measured.
- **Not measured:** any project but this one, where the ratio of project-update
  to extraction is what decides how much a skipped extraction is worth.

## 7. Decision

**Go to an implementation goal, contingent on first trying to falsify the
channel-completeness assumption.** The candidate is P1 ∧ P2 ∧ P3 ∧ P4, with P4's
roots including every global contributor. On Ambit, the check costs about 5 ms
against about 240 ms saved, and it admits 45 of 46 test files. This is not a Go
to implement P1–P4 as they stand.

Scope of the implementation goal, not started here:

- `permitsPartialExtraction` accepts external-file deltas that pass P1–P4,
  using public API only; `ProjectBaseline` gains the `fileName` sequence, the
  in-root texts (or their hashes) and a per-file global-contributor flag.
- `planUpdate` plans an empty closure for an outside-root path instead of a
  whole rebuild, and cross-checks the backend's answer.
- §6.2's outside-root row is narrowed, with an ADR beside ADR-0015 — the same
  treatment the contract-tag row got.
- Differential rows for every "yes" in §2 asserting a whole rebuild, 34–36
  above all; rows for 02–04 asserting the empty closure; byte equality with cold
  on all of them.
- Out of it: additions, deletions and renames of F; a composition with in-root
  edits beyond what `planUpdate` already does; JavaScript F.

The goal's first phase is a hard gate: no product code until a falsification
pass over channel completeness (§3) is done — looking for a checker query whose
answer depends on a non-contributing module that nothing reaches. A new channel
found there sends P1–P4 back to design; none found lets implementation start.
