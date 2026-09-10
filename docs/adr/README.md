# Architecture Decision Records

`docs/DESIGN.md` says what Ambit's design **is**. These records say **why** a
particular design is the one written there, and what was rejected on the way.

The split exists so that reading the specification does not require reading its
history. A rule and the reasoning behind it are different kinds of text with
different lifetimes: the rule has to be current, the reasoning only has to be
findable.

## What an ADR is not

It is not the minutes. A reader should be able to reconstruct why the design is
what it is in about five minutes, so a record that grows past roughly 120 lines
is a signal that something in it belongs elsewhere.

**Evidence is cited, never re-recorded.** Measured numbers live in
`docs/status.md`; the ADR links to the section that holds them and states only
the conclusion they support. A number that appears in two files will eventually
disagree with itself.

**"What would happen otherwise" is written only where it carries the decision.**
Where the consequence is already visible from the alternative itself, the
alternatives list is enough.

## Write once

An ADR is written once and not revised. Two rules follow, and they are the whole
procedure:

- **A later reconsideration gets its own record**, whatever it concludes. One
  that changes nothing links back as `Confirms: ADR-XXXX`; one that changes
  something links back as `Supersedes: ADR-XXXX`, and the superseded record
  gains a `Superseded by:` line — its only permitted edit. Never append the
  reconsideration to the original.
- **A record with a `Superseded by:` line is history**, not the specification.
  `docs/DESIGN.md` points at the record that is current.

Until `docs/DESIGN.md` §9.1's trigger — 1.0, or the first external adopter,
whichever comes first — a decision is made by editing `docs/DESIGN.md` directly
and writing the record here. From the trigger onward, the proposal goes through
`rfcs/` first, and the accepted RFC becomes the record. A record written before
the trigger stays valid as a record; where it describes the *procedure* as
starting at the first npm publish, it is describing §9 as it read at the time,
and [ADR-0010](0010-when-governance-takes-effect.md) is what changed it.

## Template

```markdown
# ADR-XXXX: <the decision, as a sentence>

- Status: Accepted | Superseded (YYYY-MM-DD)
- Decides: <the docs/DESIGN.md section this is the reasoning for>
- Evidence: <link into docs/status.md, or "none measured">
- Confirms / Supersedes / Superseded by: <ADR-XXXX, where applicable>

## Context
## Decision
## Alternatives considered
## Consequences
## Revisit when   (conditions only, no prose)
```

The headings are a shape, not a form to fill in: a section with nothing to say
is left out rather than padded.

## Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-analysis-backend.md) | The analysis backend is the JS-implemented TypeScript Compiler API | Accepted (2026-09-09) |
| [0002](0002-where-declarations-live.md) | Which contract lives in JSDoc and which in the runtime `spec` | Accepted (2026-09-10) |
| [0003](0003-out-of-code-declarations.md) | Declaring contracts in `ambit.config.ts`, and which declaration sites can be named | Accepted (2026-09-09) |
| [0004](0004-local-mutation-and-pure.md) | `pure` permits mutation of values created inside the function | Accepted (2026-09-09) |
| [0005](0005-mapping-contracts-to-handlers.md) | Contracts reach the runtime by explicit registration, not generated data | Accepted |
| [0006](0006-runtime-hook-approach.md) | Monkeypatching for builtins, client wrapping for `pg`, and the target formats | Accepted |
| [0007](0007-http-route-keys.md) | An HTTP `method + path` key does not replace explicit registration | Accepted — confirms 0005 |
| [0008](0008-approving-an-authority-increase.md) | An authority increase is approved by a ledger line valid only in the comparison that adds it | Accepted (2026-09-10) |
| [0009](0009-package-name-and-single-package.md) | The npm package is `ambit-ts`, and it stays a single package | Accepted (2026-09-10) |
| [0010](0010-when-governance-takes-effect.md) | The RFC procedure starts at 1.0 or the first external adopter; a guaranteed surface holds until then | Accepted (2026-09-10) — confirms 0001, 0009 |
