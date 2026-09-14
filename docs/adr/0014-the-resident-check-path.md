# ADR-0014: The resident path caches extraction per file and re-propagates over the impact range

- Status: Accepted (2026-09-12)
- Decides: `docs/DESIGN.md` §6.2
- Evidence: none measured for the choice, which rests on correctness and
  testability; the cost it removes is in
  [`m0.5-backend-comparison.md`](../measurements/m0.5-backend-comparison.md).

## Context

`ambit check` is one-shot, so a re-check after a one-character edit costs what
the first check cost. §6.2 asks for a resident path, and §3.5 makes it
load-bearing: the native backend's advantage is re-query latency, which cannot
appear in the product, nor gates 3 and 4 be re-run, until one exists.

Three architectures were in play, each a superset of the one before:

- **A.** Resident compiler only; recompute everything above it on each change.
- **B.** A, plus per-file extraction and summaries, and propagation scoped to
  the functions a change can reach backwards through the call graph.
- **C.** B, plus a cache written to disk and reloaded by the next process, and
  invalidation at declaration rather than file granularity.

## Decision

**B.** The resident state is keyed by file and holds only Ambit's own analysis
representation. An update re-extracts a closure of files, re-derives every
contract a config change could touch, and runs the propagation fixed point over
the reverse-reachable closure of every function whose summary changed. A failure
anywhere leaves the previous generation committed and is reported as a failure.
Full recomputation stays on the same code path as a first check. The
implementation shape is [`docs/resident-check-path.md`](../resident-check-path.md).

## Why

1. **B's correctness is a theorem; C's is a test suite.** A function outside the
   impact range cannot change, so the scoped fixed point equals the whole-tree
   one, and the whole-tree one is an in-process oracle every test can compare
   against. C's disk cache would have to prove that equality across a process
   boundary, against a file that can be stale or written by another version.
2. **A cannot be measured against what §6.2 is for**: it recomputes extraction
   and propagation in full. It is kept as the full-rebuild path, not as the
   design.
3. **The file is the granularity extraction already has.** Declaration-granular
   invalidation (C) would need the whole-program index to survive an update,
   which is the snapshot-bound state §6.2 forbids retaining.
4. **B is backend-independent.** Everything it retains already crosses the
   `TsBackend` boundary, so a second backend supplies `project-update` and
   `extraction` and inherits the rest, measured per phase.

## Alternatives rejected

- **C** — deferred, not refused: what to build if `project-update` and
  `extraction` dominate a real editor session. It would have to re-review, not
  inherit, one thing: the reuse gate skips an external input's hash comparison
  when the new program hands back the same `ts.SourceFile` object, which is safe
  only because the default `CompilerHost` never does, and a caching host is what
  C adds.
- **Incremental diagnostics.** Diagnostics, authority records and coverage are
  pure functions of the propagated state; scoping them would buy a fraction of a
  phase for a second equality proof.

## Consequences

- **Per-file slices of project-level aggregates** have to be held and re-summed:
  skipped functions, uncarried contracts, and which config keys a file's symbols
  matched — or a partial update reports keys unmatched that an earlier
  generation matched.
- **The full-rebuild rows in §6.2's table are wide on purpose.** A file addition
  is the one that is forced rather than conservative: the edges held are
  resolved import targets, so a specifier that resolved to nothing held no edge
  to close over. Each row could be narrowed with evidence; none is narrowed on
  reasoning alone, because each narrowing is a new way for a stale answer to
  survive.
- **Staleness becomes possible here for the first time.** ADR-0001 relied on the
  JS backend rebuilding everything. This ADR spends that property and buys it
  back only through §6.2's equivalence law and the differential tests asserting
  it.

## Revisit when

- A measurement shows `project-update` or `extraction` dominating a cold start in
  a resident session — the case for C.
- File additions turn out to be frequent enough in a real session to pay for an
  unresolved-specifier index.
- §3.5's gates 3 and 4 are re-run on the resident path and a second backend
  changes the phase profile.
- The equivalence law is observed to fail for a shape the differential tests do
  not cover.
