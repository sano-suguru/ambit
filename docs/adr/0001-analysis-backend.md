# ADR-0001: The analysis backend is the JS-implemented TypeScript Compiler API

- Status: Accepted (2026-09-09)
- Decides: `docs/DESIGN.md` §3.5
- Measurements: `docs/status.md`, M0.5

## Decision

The default backend for the initial release is the JS-implemented TypeScript
Compiler API (`ts.createProgram` + type checker; `typescript` 6.0.3,
`src/checker/backend/legacy-ts.ts`). Native TypeScript — the Go implementation,
distributed version 7.0.2 — is not adopted.

Because this was decided before the first public release, no RFC was raised and
`docs/DESIGN.md` was edited directly, per the procedure in §9. Changing the
default from here on follows §9 and requires an RFC.

## Reasons, in order of weight

1. **The cost of adoption does not match what it buys.** Every entry point of
   the native API is published under a name containing `unstable/*`. Adoption
   means writing a second backend implementation on top of it (2,100 lines at
   present), reconstructing missing primitives such as the equivalent of
   `getFullyQualifiedName` ourselves, and additionally taking on responsibility
   for snapshot invalidation.
2. **Gate 3 shows a difference in correctness, not cost.** Unless `fileChanges`
   is passed, the native implementation **silently returns a stale answer**
   (measured: after rewriting a contract comment it answers with the pre-change
   state, with no error and no warning). The JS implementation rebuilds the
   program every time, so it has no way of going stale. Against §3.4's "do not
   convert an analysis failure into no violations", adopting it would mean
   newly taking on a path by which a violation silently disappears.
3. **Speed buys none of the gates.** The allowance table in §3.5 was decided
   before the comparison, and the JS implementation passes all of it (median
   458 ms on 300 files against an allowance of 10 seconds; peak RSS 348 MiB
   against an allowance of 1 GiB). The native implementation is 3–4× faster,
   but as long as being faster passes not a single item, that is not a reason
   for the decision.

## A reason that was withdrawn

**Gate 2 was initially placed as the first reason for this decision. It is
withdrawn.** That the distributed version 7.0.2 does not pick up
`node_modules/@types/*` automatically is exactly as measured, as is the fact
that Ambit's own source produces 0 type errors on 5.9.3 and 198 on 7.0.2, and
that of the 1,213 calls in `src/`, 1,212 versus 1,143 resolved (58 of the 69
difference being `external`). But **this is not a property of the Go port; it is
a change in TypeScript 6 and later**: the JS-implemented 6.0.3 was afterwards
confirmed to behave identically to 7.0.2. It therefore cannot be counted as a
native-specific drawback. Writing `"types": ["node"]` explicitly in tsconfig
resolves it, and this repository, having adopted 6.0.3, does exactly that.

Gate 1 (API conformance) is not why the native implementation was dropped. The
required primitives are present, JSDoc tag positions can be obtained as AST
nodes, and positions matched in UTF-16 code units. The only thing missing is
`getFullyQualifiedName`, which looks reconstructible from the symbol's parent
chain (confirmed for one shape). This is a record that it is a cost, not a
barrier.

## The price of the decision

`typescript` 6.0.3 is not npm's `latest` (as of 2026-09, `latest` is 7.0.2).
Which tsconfig options are accepted differs by version, and 6.0.3 sits exactly
at the crossing point (measured, by giving the same file to three compilers).

| tsconfig | 5.9.3 | 6.0.3 | 7.0.2 |
|---|---|---|---|
| `baseUrl` / `downlevelIteration` | accepted | TS5101 "deprecated, will stop working in TS 7" | TS5102 "removed" |
| `importsNotUsedAsValues` | accepted | accepted | TS5023 "unknown" |
| `stableTypeOrdering` | TS5023 "unknown" | accepted | accepted |
| `deduplicatePackages` | TS5023 "unknown" | TS5023 "unknown" | accepted |

6.0.3 rejects, as "deprecated", settings that 7.0.2 removed, and accepts some of
the settings 7.0.2 introduced. It is closer to the TS 7 side of tsconfig than
staying on 5.9.3 would have been, but it is not the same. This asymmetry is left
in `docs/DESIGN.md` §12, "TypeScript version compatibility".

## What the separation in §3.4 was written for

The requirements below were written while the native API was still the first
candidate. They are not obligations now that it is not adopted, and they are
kept here as the shape any second backend would have to take, should §3.5's
conditions for revisiting be met.

- Pin the client and the engine to the same distributed version. Run the
  conformance tests and the compatibility trials when updating.
- Concentrate use of the native API in the connection layer, and insulate the
  contract model and diagnostic format from API changes.
- Measure the cost of per-call API round trips, AST transfer, and
  type-information retrieval. Use batched queries and caching where possible.
- Do not switch between backends without notice. Give diagnostics, coverage,
  and performance records information that identifies the analysis engine and
  its version.

Embedding the Go internal compiler directly is compared only if the official API
lacks required information, or if communication and transfer become the dominant
factor in measurements. Evaluating that means evaluating the cost of tracking
internal APIs, shims, and forks. If Rust is added, the target of the improvement
has to be made explicit as well: adopting a Rust parser alone cannot replace
TypeScript's type analysis, and a three-language Go / Rust / TypeScript
construction is not an initial requirement.

## Appendix: the M0.5 preliminary evaluation

This is the record made before the comparison above could be completed. **Its
numbers have been superseded** by the M0.5 measurements in `docs/status.md`; it
remains as the record of the time.

### Environment and artifacts examined

| Item | Value |
|---|---|
| Node.js | v24.19.0 |
| Native TypeScript | npm `typescript` 7.0.2 |
| Legacy TypeScript | 5.9.3 (installed under a comparison alias) |
| Oxc | `oxc-parser` 0.148.0 |
| Target | Synthetic code. No real project was provided |

The distributed version's type definitions and implementation have entry points
for types, symbols, call signatures, JSDoc, post-change snapshots, and
communication measurement. **This is confirmation that the API exists, not
completed confirmation that it works on the native version.**

### Measurements and limits

On the legacy API, 102 files and 2,009 calls were measured 5 times sequentially,
each in an independent Node process.

| Scope | Median |
|---|---:|
| Compiler import and Program construction | 708.9 ms |
| Type diagnostic retrieval | 125.8 ms |
| Extracting types, signatures, contracts and so on for all calls | 92.6 ms |
| All of the above | 953.5 ms |
| Program update after a contract-comment change and re-query of 9 calls | 21.5 ms |
| Peak RSS of the Node process | 247.7 MiB |

- Fixture generation and Node's own startup are not included in the initial
  measurement above. The OS file cache was not cooled.
- Since each stage's median is computed independently, their sum does not match
  the median of the total.
- The measurement after the comment change is a partial re-query. It is not an
  incremental check speed including Ambit's effect propagation and a full
  diagnostic update.
- The 9 cases include aliased imports, generics, overloads, callbacks, any,
  non-null assertions, unions, Unicode positions, and recursion. The assertions
  in the script succeeded on all 5 runs. This does not demonstrate conformance
  across all language features, nor an `unknown` rate.
- The Go engine could not obtain `/proc/self/exe` and halted before
  initialization. The same path's ENOENT was confirmed with Node's readlink too.
  **The comparison of the native version's speed, memory, and API behavior is
  incomplete.** This is not evidence that it does not work on Linux generally. —
  **Added 2026-09-09**: this halt was environment-specific. The same distributed
  version 7.0.2 starts on macOS (darwin/arm64), and the comparison of API
  conformance, correctness of updates, speed, and memory was completed (the M0.5
  section of `docs/status.md`). It has not been re-confirmed on Linux.
- Oxc succeeded in parsing small TS functions and comments. Type analysis,
  contract checking, and speed comparison were not carried out.

### References

- [TypeScript API source](https://github.com/microsoft/TypeScript/tree/main/packages/typescript/src/api)
- [Implementation of the synchronous API](https://github.com/microsoft/TypeScript/blob/main/packages/typescript/src/api/sync/api.ts)
- [The former development repository for the native TypeScript port](https://github.com/microsoft/typescript-go)
- [Oxlint's type-aware checks](https://oxc.rs/docs/guide/usage/linter/type-aware.html)
- [tsgolint's shim generation](https://github.com/oxc-project/tsgolint/blob/main/tools/gen_shims/main.go)
- [The Oxc parser](https://oxc.rs/docs/guide/usage/parser.html)
- [Node.js release list](https://nodejs.org/en/about/previous-releases)
- [Constraints of the Node.js Permission Model](https://nodejs.org/download/release/v25.6.1/docs/api/permissions.html)

Do not equate the web's main branch with the pinned distributed version's API.
The direct API confirmation in this preliminary evaluation was done against
distributed version 7.0.2.
