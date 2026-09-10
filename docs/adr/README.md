# Architecture Decision Records

`docs/DESIGN.md` says what Ambit's design **is**. These records say **why** a
particular design is the one written there, and what was rejected on the way.

The split exists so that reading the specification does not require reading its
history. A rule and the reasoning behind it are different kinds of text with
different lifetimes: the rule has to be current, the reasoning only has to be
findable. `docs/DESIGN.md` therefore carries the rule, the limits of what it
guarantees, and a link to the record; the record carries the options that were
considered, the measurements, and what would have happened otherwise.

An ADR is written once and not revised. If a decision changes, a new record
supersedes the old one and `docs/DESIGN.md` points at the new one. A record with
a `Superseded by` line is history and is not the specification.

Until the first npm publish, a decision is made by editing `docs/DESIGN.md`
directly and writing the record here (`docs/DESIGN.md` §9). From the first
publish onward, the proposal goes through `rfcs/` first, and the accepted RFC
becomes the record.

| # | Decision | Status |
|---|---|---|
| [0001](0001-analysis-backend.md) | The analysis backend is the JS-implemented TypeScript Compiler API | Accepted (2026-09-09) |
| [0002](0002-where-declarations-live.md) | Which contract lives in JSDoc and which in the runtime `spec` | Accepted (2026-09-10) |
| [0003](0003-out-of-code-declarations.md) | Declaring contracts in `ambit.config.ts`, and which declaration sites can be named | Accepted (2026-09-09) |
| [0004](0004-local-mutation-and-pure.md) | `pure` permits mutation of values created inside the function | Accepted (2026-09-09) |
| [0005](0005-mapping-contracts-to-handlers.md) | Contracts reach the runtime by explicit registration, not generated data | Accepted |
| [0006](0006-runtime-hook-approach.md) | Monkeypatching for builtins, client wrapping for `pg`, and the target formats | Accepted |
