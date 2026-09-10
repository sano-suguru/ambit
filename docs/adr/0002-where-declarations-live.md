# ADR-0002: Which contract lives in JSDoc and which in the runtime `spec`

- Status: Accepted (2026-09-10)
- Decides: `docs/DESIGN.md` §4.1 "Where declarations live", §4.4 "Removing the
  double declaration"
- Evidence: none measured
- Depends on: [ADR-0005](0005-mapping-contracts-to-handlers.md)

## Context

Three places can declare a contract — JSDoc, `ambit.config.ts`, and the `spec` of
a runtime registration — and before this decision, a handler with runtime
enforcement had `capabilities` and `budget` written twice: once in the tag the
checker reads, once in the `spec` the runtime reads.

## Decision

One question decides where a contract is written: **does it have to reach
runtime?**

`@effects`, `@entrypoint` and `@boundary` are read only by the static check, so
they live in JSDoc. `capabilities` and `budget` are matched and measured by the
runtime, so where runtime enforcement is in place the authoritative copy is the
`spec` of `withAmbit` / `ambitHandler` / `ambitRoute`. When a `spec` fixes them
as literals and `handler` names a declaration in the same file, that value **is**
that handler's `@capabilities` / `@budget` declaration; writing the same content
again in JSDoc is not required.

## Alternatives considered

- **Make JSDoc authoritative and deliver it to the runtime** (option 2 of
  ADR-0005 / `--emit-contracts` / the middleware approach). ADR-0005's three
  reasons apply unchanged. In addition, the double writing arises **only for
  people who put runtime enforcement in place**, and those people have already
  written the wrapper. Making `spec` authoritative adds not one line and removes
  two from JSDoc, whereas making JSDoc authoritative requires a delivery
  mechanism **on top of** the existing wrapper. The intrusion does not shrink;
  only the machinery grows.
- **A build-time transform that injects wrappers from JSDoc** (a Phase 1
  non-goal in §4.5). It brings in coupling to the build step just as ADR-0005's
  option B does, and is rejected for the same reason.
- **Put `@effects` in `spec` too.** `effects` is attached to every function, and
  a wrapper that exists only at entry points cannot carry it. The granularity
  does not match.
- **Infer `@entrypoint` from the fact of being wrapped.** `@entrypoint` is one
  line and was never duplicated in the first place. Inferring it would make
  "forgot to wrap" indistinguishable from "not an entry point".

## Consequences

JSDoc disappears at build time. Putting data that must reach runtime there
requires inventing a delivery mechanism every time — which is exactly what
[ADR-0005](0005-mapping-contracts-to-handlers.md) rejected. Conversely `effects`
is not needed at runtime, so JSDoc is the right place for it. The split lines up
with the granularity trade-off in §4.1: static checking is per function, runtime
enforcement is per entry point.

### Why the agreement check keeps its severity

`AMB-E010` / `AMB-E011` **stay. Neither their meaning nor their severity
changes.** If both a `spec` and a JSDoc tag are written and they disagree, it is
an error. What changed is only that "the JSDoc side may be absent", not that
"disagreement is allowed". This is why `spec` is placed last in the merge order
(JSDoc > config > `spec`): if JSDoc or config declares something, that takes
effect, and `spec` is compared against that declaration.

A separate id (`AMB-E011`) was used for budgets rather than extending
`AMB-E010` because `AMB-E010`'s `contract` field holds capability strings
(`declared` / `required` / `excess`), and a budget disagreement has nothing that
fits there.

### The check this decision gives up

In the era of writing it twice, an edit that widened only `spec` was caught by
`AMB-E010` as "the pair disagrees". Once the declaration is in one place there is
no pair, so that way of catching it is gone.

This is not a reduction in the contract's guaranteed surface. `AMB-E010` /
`AMB-E011` were never a mechanism for catching capability expansion itself; they
were a mechanism for watching that duplicates did not disagree (an edit widening
both sides at once always passed silently). A declaration written in `spec` shows
up in the diff like every other Ambit contract, is bound from its callers by the
narrowing rule of §4.4 (`AMB-E005`), and its literal targets are checked by
`AMB-E009`.
