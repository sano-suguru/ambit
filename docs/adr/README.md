# Architecture Decision Records

`docs/DESIGN.md` says what Ambit's design **is**. These records say **why** a
particular design is the one written there, and what was rejected on the way.

The split exists so that reading the specification does not require reading its
history. A rule and the reasoning behind it are different kinds of text with
different lifetimes: the rule has to be current, the reasoning only has to be
findable.

## When to write one

**Write an ADR when the decision is irreversible, changes the guaranteed surface
(`docs/DESIGN.md` §9.2), or has a security consequence.**

**If the decision is easily reversible and has neither of those consequences, do
not write one.** Git history already holds it. A record for a choice that can be
undone in an afternoon costs more to read, for everyone who reads the directory
afterwards, than it ever saved.

## What an ADR is not

It is not the minutes. A reader should be able to reconstruct why the design is
what it is in about five minutes, so a record past roughly **80 lines** is a
signal that something in it belongs elsewhere.

**Evidence is cited, never re-recorded.** Measured numbers live in
`docs/status.md` and `docs/measurements/`; the ADR links to the record that
holds them and states only the conclusion they support. A number that appears in
two files will eventually disagree with itself. **A spike write-up is a
measurement, not a decision** — it goes in `docs/measurements/`.

**"What would happen otherwise" is written only where it carries the decision.**
Where the consequence is already visible from the alternative itself, naming the
alternative is enough.

## Write once

An ADR records a decision as it was made, and is not rewritten to say something
else. Two rules follow, and they are the whole procedure:

- **A later reconsideration gets its own record**, whatever it concludes. One
  that changes nothing links back as `Confirms: ADR-XXXX`; one that changes
  something links back as `Supersedes: ADR-XXXX`, and the superseded record
  gains a `Superseded by:` line. Never append the reconsideration to the
  original.
- **A record with a `Superseded by:` line is history**, not the specification.
  `docs/DESIGN.md` points at the record that is current.

**Editing for length is not rewriting**, and is permitted: moving evidence to
`docs/measurements/`, cutting an alternative whose rejection is self-evident,
and tightening prose all leave the decision, its reasons, and its rejected
alternatives exactly where they were. What write-once forbids is changing what
the record says was decided, or why.

Until `docs/DESIGN.md` §9.1's trigger — 1.0, or the first external adopter,
whichever comes first — a decision is made by editing `docs/DESIGN.md` directly
and writing the record here. From the trigger onward, the proposal goes through
`rfcs/` first, and the accepted RFC becomes the record. See
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## Template

```markdown
# ADR-XXXX: <the decision, as a sentence>

- Status: Accepted | Superseded (YYYY-MM-DD)
- Decides: <the docs/DESIGN.md section this is the reasoning for>
- Evidence: <link into docs/measurements/, or "none measured">
- Confirms / Supersedes / Superseded by: <ADR-XXXX, where applicable>

## Context
One paragraph: what forced a decision.

## Decision
One to three sentences.

## Why
Three to five points.

## Alternatives rejected
Only alternatives that were genuinely in play.

## Consequences
Only the non-obvious costs.

## Revisit when
Observable conditions only, no prose.
```

The headings are a shape, not a form to fill in: a section with nothing to say
is left out rather than padded.

## Records

| # | Decision | Status |
|---|---|---|
| [0001](0001-analysis-backend.md) | The analysis backend is the JS-implemented TypeScript Compiler API | Accepted (2026-09-09) |
| [0002](0002-where-declarations-live.md) | Which contract lives in JSDoc and which in the runtime `spec` | Accepted (2026-09-10) |
| [0003](0003-out-of-code-declarations.md) | Contracts may be declared in `ambit.config.ts` | Accepted (2026-09-09) |
| [0004](0004-local-mutation-and-pure.md) | `pure` permits mutation of values created inside the function | Accepted (2026-09-09) |
| [0005](0005-mapping-contracts-to-handlers.md) | Contracts reach the runtime by explicit registration, not generated data | Accepted — confirmed by 0007 |
| [0006](0006-runtime-hook-approach.md) | Monkeypatching for builtins, client wrapping for `pg`, and the target formats | Accepted |
| [0007](0007-http-route-keys.md) | An HTTP `method + path` key does not replace explicit registration | Accepted — confirms 0005 |
| [0008](0008-approving-an-authority-increase.md) | Authority approvals are comparison-scoped | Accepted (2026-09-10) |
| [0009](0009-package-name-and-single-package.md) | The npm package is `ambit-ts`, and it stays a single package | Accepted (2026-09-10) |
| [0010](0010-when-governance-takes-effect.md) | The RFC procedure starts at 1.0 or the first external adopter | Accepted (2026-09-10) — confirms 0001, 0009 |
| [0011](0011-reporting-why-a-contract-cannot-be-proposed.md) | `ambit init` reports why it cannot propose a contract, and proposes no `@boundary` | Accepted (2026-09-11) |
| [0012](0012-reporting-an-unresolvable-gain.md) | An unresolvable gain is reported, and gated only on request | Accepted (2026-09-11) — extends 0008 |
| [0013](0013-the-inline-callback-owner.md) | A file's inline callbacks are one entry, compared as a multiset over its bodies | Accepted (2026-09-11) — extends 0008 |
