# ADR-0014: The resident path caches extraction per file and re-propagates over the impact range

- Status: Accepted (2026-09-12)
- Decides: `docs/DESIGN.md` §6.2
- Evidence: none measured. The only number in play is the cost the resident path
  is meant to remove — a re-query today rebuilds the whole program, 214–272 ms on
  the gate-3 corpus ([`docs/measurements/m0.5-backend-comparison.md`](../measurements/m0.5-backend-comparison.md)).
  What the design is chosen on is correctness and testability, not a predicted
  speedup.

## Context

`ambit check` is one-shot: `analyze()` loads the config, builds a `ts.Program`,
extracts every file, summarizes, propagates, and exits. A re-check after a
one-character edit costs what the first check cost. §6.2 has always asked for a
resident path instead, and §3.5 makes it load-bearing for something else: the
native backend's advantage is re-query latency, and until a resident path exists
that advantage cannot appear in the product, so gates 3 and 4 cannot be re-run.

Three architectures were in play. Each is a superset of the one before it.

- **A. Resident compiler only.** Hold the `ts.Program` and its host alive; rebuild
  it against the previous one on each change and recompute everything above it.
- **B. Resident compiler, per-file extraction and summaries, impact-scoped
  propagation.** Re-extract the changed files and their dependents, keep every
  other file's extraction, and re-run the fixed point over the functions the
  change can reach backwards through the call graph.
- **C. B, plus a cache written to disk and reloaded by the next process, and
  invalidation at declaration rather than file granularity.**

## Decision

**B.** The resident state is keyed by file and holds only Ambit's own analysis
representation. An update re-extracts a closure of files, re-derives every
contract that a config change could touch, and runs the propagation fixed point
over the impact range — the reverse-reachable closure, through resolved calls, of
every function whose summary changed. A failure anywhere leaves the previous
generation committed and is reported as a failure. Full recomputation stays on
the same code path as a first check and is what the invalidation table in §6.2
falls back to. The implementation shape is
[`docs/resident-check-path.md`](../resident-check-path.md).

## Why

1. **B's correctness is a theorem; C's is a test suite.** A function's propagated
   value depends only on its own summary and the values of its resolved callees,
   so a function outside the impact range cannot change — which makes the
   impact-scoped fixed point provably equal to the whole-tree one, and makes the
   whole-tree one a cheap in-process oracle every test can compare against.
   C's disk cache has to prove the same equality across a process boundary,
   against a file that can be stale, truncated, or written by another version.
   Nothing in §6.2 asks for that yet.
2. **A cannot be measured against what §6.2 is for.** Its re-check recomputes
   extraction and propagation in full, so a measurement of it says how fast the
   compiler reuses a program and nothing about the phases §6.2 names. It is kept
   — as the full-rebuild path — and rejected as the design.
3. **The file is the granularity the extraction layer already has.**
   `extractProject` produces one `ExtractedFile` per source file and resolves
   calls through a whole-program index; a declaration-granular invalidation (C)
   would need that index to survive an update, which is exactly the
   snapshot-bound state §6.2 forbids retaining.
4. **B is backend-independent.** Everything it retains crosses the `TsBackend`
   boundary already, so a second backend supplies `project-update` and
   `extraction` and inherits the rest unchanged. The gates §3.5 would re-run then
   are measured per phase (§6.2), which is what makes the two comparable.

## Alternatives rejected

- **A** — above: retained as the full-rebuild path, rejected as the design.
- **C** — deferred, not refused. It is what to build if `project-update` and
  `extraction` turn out to dominate a cold start in a real editor session, and
  that is a measurement nobody has taken.
- **Incremental diagnostics.** Recomputing diagnostics, authority records, and
  coverage for the whole tree each generation is kept deliberately: they are pure
  functions of the propagated state with no compiler in them, and scoping them
  would buy a fraction of a phase in exchange for a second equality proof.

## Consequences

**Two aggregates have to be held per file that are project-level today.**
`ExtractedProject.skippedFunctions` and `uncarriedContracts` are produced per
file and summed once; the store has to keep the per-file slices and re-sum them.
So does the set of `ambit.config.ts` keys a file's symbols matched: today
`ResolvedConfig` accumulates that as a side effect of every `contractFor` call
across a whole run, and a partial re-summarization would report keys as unmatched
that an earlier generation matched.

**The full-rebuild rows in §6.2's table are wide on purpose.** A compiler-option
change, an installed dependency, a `.d.ts` or a global augmentation all force a
whole rebuild rather than a computed closure. Each could be narrowed later with
evidence; each narrowing is a new way for a stale answer to survive, so none is
narrowed on reasoning alone.

**A resident path makes staleness possible here for the first time.** ADR-0001
rejected the native backend partly because it answers from a stale snapshot
unless told what changed, and the JS implementation could not go stale because it
rebuilt everything. That property is what this ADR spends. It is bought back by
§6.2's equivalence law and by the differential tests that assert it, and by
nothing else.

## Revisit when

- A measurement shows `project-update` or `extraction` dominating a cold start in
  a resident session — the case for C.
- §3.5's gates 3 and 4 are re-run on the resident path and a second backend
  changes the phase profile.
- The equivalence law is observed to fail for a shape the differential tests do
  not cover.
