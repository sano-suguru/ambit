# ADR-0001: The analysis backend is the JS-implemented TypeScript Compiler API

- Status: Accepted (2026-09-09)
- Decides: `docs/DESIGN.md` §3.5
- Evidence: [`docs/measurements/m0.5-backend-comparison.md`](../measurements/m0.5-backend-comparison.md). Every
  number this record relies on is measured there; none is repeated here.

## Context

Ambit needs type information, symbols and call signatures from a TypeScript
compiler, and §3.4 puts whichever one it uses behind a connection layer. Two
candidates existed at M0.5: the JS-implemented Compiler API (`ts.createProgram`
+ type checker), and native TypeScript — the Go implementation, distributed
version 7.0.2 — through its official client.

§3.5's five gates, and the allowances below, were fixed **before** the
comparison ran, so that measuring first and then choosing a passing threshold
could not happen.

| Item | Allowance | Rationale |
|---|---|---|
| Initial-check latency (30 files) | within 3 s | In one generate → check → fix iteration, the check must not be the dominant wait |
| Initial-check latency (300 files) | within 10 s | Same. Must not degrade worse than linearly in file count |
| Re-query after a one-file change | within 500 ms | The premise on which §6.2's resident path holds |
| Peak RSS, parent and child summed (300 files) | within 1 GiB | A standard CI environment, coexisting with an editor |
| Transfer time, process-separated | not the dominant factor; ≤ 50% of total | The line for calling transport dominant (§3.4) |

## Decision

The default backend is the JS-implemented Compiler API (`typescript` 6.0.3,
`src/checker/backend/legacy-ts.ts`). Native TypeScript is not adopted.

## Reasons, in order of weight

1. **The cost of adoption does not match what it buys.** Every entry point of
   the native API is published under a name containing `unstable/*`. Adoption
   means writing a second backend on top of it (2,100 lines at present),
   reconstructing missing primitives such as the equivalent of
   `getFullyQualifiedName`, and taking on responsibility for snapshot
   invalidation.
2. **Gate 3 shows a difference in correctness, not cost.** Unless `fileChanges`
   is passed, the native implementation **silently returns a stale answer**:
   after a contract comment is rewritten it answers with the pre-change state,
   with no error and no warning. The JS implementation rebuilds the program every
   time and cannot go stale. Adopting the native one would mean newly taking on a
   path by which a violation silently disappears — against §3.4.
3. **Speed buys none of the gates.** The JS implementation passes every
   allowance with room to spare, and the native implementation's 3–4× advantage
   passes not a single additional item. Being faster is not, by itself, a reason.

**Gate 1 is not why the native implementation was dropped**: the required
primitives are present, and only `getFullyQualifiedName` is missing, which is a
cost rather than a barrier. **Gate 2 was first written as the leading reason and
is withdrawn**: the type-resolution gap it measured is a change in TypeScript 6
and later, not a property of the Go port, and the JS-implemented 6.0.3 was
afterwards confirmed to behave identically. Writing `"types": ["node"]` in
tsconfig resolves it.

## Alternatives rejected

- **Native TypeScript 7 through its official client** — the comparison above.
- **Embedding the Go compiler directly.** Compared only if the official API
  lacks required information, or if communication and transfer dominate the
  measurements — and that comparison must include the cost of tracking internal
  APIs, shims and forks.
- **A Rust parser.** A parser alone cannot replace TypeScript's type analysis,
  and a three-language construction is not an initial requirement.

## Consequences

**The pinned version is not npm's `latest`.** As of 2026-09, `latest` is 7.0.2
while Ambit runs 6.0.3, and the two accept different tsconfig options. One
consequence is user-visible: a tsconfig naming `deduplicatePackages` is accepted
only by 7.0.2, so under that configuration `ambit check` does not start at all.
That asymmetry is left open in [`docs/open-questions.md`](../open-questions.md).

**What a second backend would have to take on**, kept here because §3.4 no
longer carries it: pin client and engine to the same distributed version and
re-run the conformance and compatibility trials on every update; confine API use
to the connection layer; measure round trips, AST transfer and type retrieval,
and batch or cache where possible.

## Revisit when

- The `unstable` name comes off the native API.
- §6.2's resident check path is implemented, so that the native implementation's
  advantage — re-querying after a one-file change, not the initial check — can
  show up in the product at all. Re-run gates 3 and 4 then.
- The JS-implementation line stops producing stable releases, which would
  collapse gate 5's maintenance-cost premise.
