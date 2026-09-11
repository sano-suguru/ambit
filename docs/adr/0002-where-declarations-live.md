# ADR-0002: Which contract lives in JSDoc and which in the runtime `spec`

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §4.1 "Where declarations live", §4.4 "Removing the
  double declaration"
- Evidence: none measured
- Depends on: [ADR-0005](0005-mapping-contracts-to-handlers.md)

**This record decides declaration *ownership* only — which of three places is
authoritative for which tag. *How* a contract reaches the running process is
[ADR-0005](0005-mapping-contracts-to-handlers.md), and this decision assumes its
answer.**

## Context

Three places can declare a contract — JSDoc, `ambit.config.ts`, and the `spec`
of a runtime registration. Before this decision, a handler with runtime
enforcement had `capabilities` and `budget` written twice: once in the tag the
checker reads, once in the `spec` the runtime reads.

## Decision

One question decides where a contract is written: **does it have to reach
runtime?**

`@effects`, `@entrypoint` and `@boundary` are read only by the static check, so
they live in JSDoc. `capabilities` and `budget` are matched and measured by the
runtime, so where runtime enforcement is in place the authoritative copy is the
`spec`. When a `spec` fixes them as literals and `handler` names a declaration in
the same file, that value **is** that handler's `@capabilities` / `@budget`;
writing the same content again in JSDoc is not required.

## Why

JSDoc disappears at build time, so putting data that must reach runtime there
requires inventing a delivery mechanism — which is what ADR-0005 rejected. The
split also lines up with §4.1's granularity trade-off: static checking is per
function, runtime enforcement is per entry point.

The double writing arises **only for people who already wrote the wrapper**.
Making `spec` authoritative adds not one line and removes two from JSDoc;
making JSDoc authoritative requires a delivery mechanism **on top of** the
wrapper that already exists. The intrusion does not shrink; only the machinery
grows.

## Alternatives rejected

- **Make JSDoc authoritative and deliver it to the runtime** — ADR-0005's three
  reasons, plus the paragraph above.
- **A build-time transform injecting wrappers from JSDoc** — a Phase 1 non-goal
  (§4.5), and the same build coupling.
- **Put `@effects` in `spec` too.** `effects` attaches to every function; a
  wrapper that exists only at entry points cannot carry it.
- **Infer `@entrypoint` from being wrapped.** It is one line and was never
  duplicated. Inferring it would make "forgot to wrap" indistinguishable from
  "not an entry point".

## Consequences

**The agreement check keeps its severity.** `AMB-E010` / `AMB-E011` stay, and
mean what they meant: if both a `spec` and a JSDoc tag are written and they
disagree, it is an error. What changed is that the JSDoc side may be absent, not
that disagreement is allowed. This is why `spec` is last in the merge order.

**One check is given up.** When it was written twice, an edit that widened only
`spec` was caught as "the pair disagrees". With the declaration in one place
there is no pair. This is not a reduction in the guaranteed surface —
`AMB-E010` / `AMB-E011` never caught capability expansion itself, only
disagreement between duplicates, and an edit widening both sides at once always
passed silently. A declaration in `spec` shows up in `ambit diff` like any other
contract, is bound by the narrowing rule (`AMB-E005`), and its literal targets
are checked by `AMB-E009`.
