# ADR-0001: The analysis backend is the JS-implemented TypeScript Compiler API

- Status: Accepted (2026-09-09)
- Decides: `docs/DESIGN.md` §3.5
- Evidence: `docs/status.md`, "M0.5 — the backend comparison, measured". Every
  number this record relies on is measured there; none is repeated here.

## Context

Ambit needs type information, symbols and call signatures from a TypeScript
compiler, and §3.4 puts whichever one it uses behind a connection layer. Two
candidates existed at M0.5: the JS-implemented Compiler API
(`ts.createProgram` + type checker), and native TypeScript — the Go
implementation, distributed version 7.0.2 — through its official client.

`docs/DESIGN.md` §3.5 fixed five gates and a table of latency and memory
allowances **before** the comparison ran, so that measuring first and then
choosing a passing threshold could not happen.

## Decision

The default backend for the initial release is the JS-implemented Compiler API
(`typescript` 6.0.3, `src/checker/backend/legacy-ts.ts`). Native TypeScript is
not adopted.

Because this was decided before the first public release, no RFC was raised and
`docs/DESIGN.md` was edited directly, per §9. Changing the default from here on
requires an RFC.

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
   time and has no way of going stale. Adopting the native one would mean newly
   taking on a path by which a violation silently disappears — against §3.4's
   "do not convert an analysis failure into no violations".
3. **Speed buys none of the gates.** The JS implementation passes every
   allowance with room to spare, and the native implementation's 3–4× advantage
   passes not a single additional item. Being faster is not, by itself, a reason.

**Gate 2 was first written as the leading reason, and is withdrawn.** The
measured difference is real — the native distribution does not pick up
`node_modules/@types/*` automatically, and the resulting type-error and
call-resolution gaps are recorded under gate 2 in `docs/status.md`. But it is
**not a property of the Go port; it is a change in TypeScript 6 and later**, and
the JS-implemented 6.0.3 was afterwards confirmed to behave identically. It
cannot be counted as a native-specific drawback. Writing `"types": ["node"]`
explicitly in tsconfig resolves it, and this repository does exactly that.

**Gate 1 is not why the native implementation was dropped.** The required
primitives are present, JSDoc tag positions are obtainable as AST nodes, and
positions match in UTF-16 code units. Only `getFullyQualifiedName` is missing,
and it looks reconstructible from the symbol's parent chain (confirmed for one
symbol shape). That is a cost, not a barrier.

## Consequences

**The pinned version is not npm's `latest`.** As of 2026-09, `latest` is 7.0.2
while Ambit runs 6.0.3. Which tsconfig options each version accepts differs, and
6.0.3 sits exactly at the crossing point: it rejects as "deprecated" the settings
7.0.2 removed, and accepts some of the settings 7.0.2 introduced — but not all of
them. The three-compiler comparison is under gate 2 in `docs/status.md`. One
consequence is user-visible: a tsconfig naming `deduplicatePackages` is accepted
only by 7.0.2, so under that configuration `ambit check` does not start at all.
This asymmetry is left open in `docs/DESIGN.md` §12, "TypeScript version
compatibility".

**The requirements §3.4 wrote for a native backend are not obligations.** They
were written while it was still the first candidate, and are kept here as the
shape any second backend would have to take: pin client and engine to the same
distributed version and re-run the conformance and compatibility trials on every
update; confine API use to the connection layer; measure round trips, AST
transfer and type retrieval, and batch or cache where possible.

Embedding the Go compiler directly is compared only if the official API lacks
required information, or if communication and transfer dominate the
measurements — and that comparison has to include the cost of tracking internal
APIs, shims and forks. If Rust is ever added, the target of the improvement has
to be named: a Rust parser alone cannot replace TypeScript's type analysis, and a
three-language construction is not an initial requirement.

## Revisit when

- The `unstable` name comes off the native API, so that writing a second backend
  stops being a bet on an unstable API.
- §6.2's resident check path is implemented. The native implementation's real
  advantage is re-querying after a one-file change, not the initial check, and
  with no resident path that difference shows up nowhere in the product. Re-run
  gates 3 and 4 once it exists.
- The JS-implementation line stops producing stable releases. The decision
  depends on tracking its latest stable release (§3.1, `AGENTS.md`); with nothing
  left to track, gate 5's maintenance-cost premise collapses.

## References consulted

- [TypeScript API source](https://github.com/microsoft/TypeScript/tree/main/packages/typescript/src/api)
- [Implementation of the synchronous API](https://github.com/microsoft/TypeScript/blob/main/packages/typescript/src/api/sync/api.ts)
- [The former development repository for the native TypeScript port](https://github.com/microsoft/typescript-go)
- [Oxlint's type-aware checks](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [tsgolint's shim generation](https://github.com/oxc-project/tsgolint/blob/main/tools/gen_shims/main.go)
- [The Oxc parser](https://oxc.rs/docs/guide/usage/parser.html)
- [Node.js release list](https://nodejs.org/en/about/previous-releases)
- [Constraints of the Node.js Permission Model](https://nodejs.org/download/release/v25.6.1/docs/api/permissions.html)
