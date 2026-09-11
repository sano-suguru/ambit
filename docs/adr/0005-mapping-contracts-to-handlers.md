# ADR-0005: Contracts reach the runtime by explicit registration, not generated data

- Status: Accepted
- Decides: `docs/DESIGN.md` §4.4 "Runtime enforcement is per entry point"
- Evidence: none measured. The runtime overhead — one context and one `decode` —
  is **unmeasured**.
- Reconsidered by: [ADR-0007](0007-http-route-keys.md)

> **Current decision: explicit registration.** Revalidated on different grounds
> by [ADR-0007](0007-http-route-keys.md), which reopened this against the one
> key bundlers *do* preserve and confirmed it unchanged.

## Context

A contract declared in JSDoc has to reach the process that enforces it, and
JSDoc does not survive a build. Something has to carry `capabilities` and
`budget` from the source into the running handler.

## Decision

`ambitHandler(spec, handler, decode)` — the contract and the function that
declared it in the same call. The contract is a **value inside the module**.

## Alternatives rejected

- **Contract-data generation** — `ambit check` writes symbol ID → contract, and
  the runtime matches it against the running handler. Fails on the key: every
  symbol-shaped candidate (symbol ID, `fn.name`) is rewritten by bundlers and
  minifiers by default, and the transform that would sidestep this by injecting
  wrappers from JSDoc is a Phase 1 non-goal (§4.5). It also introduces a failure
  mode registration does not have: generated data goes **stale**, so a process
  running against an edited source enforces a contract written nowhere in it —
  the static check and execution silently disagreeing.
- **Both, with generated data filling in for unregistered handlers.** Does not
  solve the key problem and adds one: which side wins when the two disagree.

## Consequences

**A contract survives the build** — comment removal, bundling, minification. The
runtime reads no JSDoc and refers to neither symbol IDs, file paths, nor
function names, which also keeps any type-analysis engine out of the runtime.

**`decode` is separate for a reason.** A framework's `Context` API is not in the
stub table, so a handler calling `c.req.json()` directly would contain `unknown`
(`AMB-W001` / `AMB-W003`), leaving its declared capabilities "not fully
determined". Confining framework-dependent calls to the third parameter keeps
the contract-declaring handler statically analyzable.

**Registration is per route, and its absence is visible.** A handler registered
without the adapter pushes no context, and `runtime.unscoped` decides what its
operations do. The adapter does **not** push an empty capability set for it: the
empty set is a total denial, which would make a missing registration
indistinguishable from a policy decision.

**Denial is not translated into an HTTP status.** `AmbitCapabilityError` /
`AmbitBudgetError` reach the framework's error handler unchanged. 403 says "the
client lacks permission" when what happened is "the server's code exceeded its
own grant". Translating would also force a choice between exposing the exception
message — the list of permitted capabilities — to the client and dropping
information in order not to.

**The cost is per route**: roughly 6 lines (measured: 44 lines across
`test/fixtures/realistic-api`'s 7 routes). ADR-0007 weighs that against the
alternative.
