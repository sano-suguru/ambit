# ADR-0005: Contracts reach the runtime by explicit registration, not generated data

- Status: Accepted
- Decides: `docs/DESIGN.md` §4.4 "Runtime enforcement is per entry point"
- Evidence: none measured. The runtime overhead — one context and one `decode` —
  is **unmeasured**.
- Reconsidered by: [ADR-0007](0007-http-route-keys.md) (decision unchanged)

## Context

A contract declared in JSDoc has to reach the process that enforces it, and
JSDoc does not survive a build. Something has to carry `capabilities` and
`budget` from the source into the running handler.

## Decision

The adapter takes the form `ambitHandler(spec, handler, decode)`, placing the
contract and the function that declared it in the same call. The contract is a
**value inside the module**.

## Alternatives considered

1. **Explicit registration** (adopted).
2. **Contract-data generation** — `ambit check` writes out contract data
   (symbol ID → contract), and the runtime matches it against the running
   handler.
3. **Both** — 1 as the base, with generated data filling in for unregistered
   handlers.

2 fails on the key. Every symbol-shaped candidate — the symbol ID (file path +
declaration path) and `fn.name` — is something bundlers and minifiers rewrite,
and is not preserved by default. The transform that would sidestep this by
injecting wrappers from JSDoc is a Phase 1 non-goal (§4.5), so an approach
premised on it cannot be chosen now. 2 also introduces a failure mode 1 does not
have: generated data goes **stale**, and a process running against a source that
was edited without re-running `ambit check` enforces a contract written nowhere
in the current source — the static check and execution silently disagreeing
about the same contract.

3 does not solve 2's key problem and adds one of its own: which side wins when a
registered contract and the contract data disagree. While 1 suffices, there is
nothing to pay for the addition.

[ADR-0007](0007-http-route-keys.md) reopened this against the one key bundlers
*do* preserve, `method + path`, and confirmed the decision on different grounds.

## Consequences

**A contract survives the build.** It reaches runtime as-is through comment
removal (`tsc`, esbuild, SWC), bundling, and minification. The runtime reads no
JSDoc and refers to neither symbol IDs, file paths, nor function names — which
also satisfies, for free, the condition that no type-analysis engine enters the
runtime.

**`decode` is separate for a reason.** A framework's `Context` API is not in
Ambit's stub table, so a handler calling `c.req.json()` directly would contain
`unknown` (`AMB-W001` / `AMB-W003`), leaving the capabilities it declared "not
fully determined". Confining framework-dependent calls to the third parameter
keeps the contract-declaring handler framework-independent and statically
analyzable.

**Registration is per route, and its absence is visible.** A handler registered
without the adapter pushes no context, and `runtime.unscoped` decides what its
operations do. The adapter does **not** push an empty capability set for such a
handler: the empty set is a total denial, and using it here would make a missing
registration indistinguishable from a policy decision. Because the registration
API requires `spec`, "registered via the adapter but with no contract" cannot be
created.

**Denial is not translated into an HTTP status.** `AmbitCapabilityError` /
`AmbitBudgetError` reach the framework's error handler unchanged. 403 says "the
client lacks permission", when what happened is "the server's code exceeded its
own grant" — a different claim; 504 likewise asserts a state of the gateway.
Translating would also force a choice between exposing the exception message
(the list of permitted capabilities) to the client and dropping information in
order not to.

**The cost is per route.** Registration costs roughly 6 lines per route
(measured: 44 lines across `test/fixtures/realistic-api`'s 7 routes). ADR-0007
weighs that against the alternative.
