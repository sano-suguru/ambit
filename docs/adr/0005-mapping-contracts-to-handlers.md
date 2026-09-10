# ADR-0005: Contracts reach the runtime by explicit registration, not generated data

- Status: Accepted
- Decides: `docs/DESIGN.md` §4.4 "Runtime enforcement is per entry point"
- Superseded by: nothing. Reconsidered once (below) without change.

## Decision

The adapter takes the form `ambitHandler(spec, handler, decode)`, placing `spec`
(the contract) and `handler` (the function that declared the contract) in the
same call. The contract becomes a runtime value inside the module.

Options considered:

1. **Explicit registration** — pass the handler and the contract to the adapter
   together (adopted).
2. **Contract-data generation** — `ambit check` writes out contract data (symbol
   ID → contract) from JSDoc, and the runtime reads it and matches it against the
   running handler.
3. **Both** — explicit registration as the base, with contract data filling in
   for unregistered handlers.

## Reasons

- Because the contract is a **value inside the module**, it reaches runtime as-is
  even through a build that drops comments (`tsc`, esbuild, SWC JSDoc removal)
  and after bundling and minification. The runtime does not read JSDoc, and
  refers to neither symbol IDs, file paths, nor function names. The condition of
  not bringing a type-analysis engine into the runtime is automatically satisfied
  as well.
- 2 requires a key linking the contract data to the running handler. **As long as
  the key is a symbol**, every candidate (symbol ID = file path + declaration
  path, `fn.name`) is something bundlers and minifiers rewrite, and is not
  preserved by default. A transform that injects wrappers from JSDoc is a Phase 1
  non-goal in §4.5, so an approach premised on that transform cannot be chosen
  now.
- 2 further introduces a failure mode in which the generated contract data goes
  **stale**. Run in a state where the source has been fixed but `ambit check` has
  not been passed, the runtime enforces a contract that is written nowhere in the
  current source. That is a state in which the static check and execution
  silently give different answers about the same contract.
- 3 does not solve 2's key problem and adds a failure mode: which to take when a
  registered contract and the contract data disagree. While 1 suffices, there is
  nothing to pay for the addition.
- The runtime overhead (one context and one `decode`) is **unmeasured**.

What would happen otherwise: taking only 2 and not 1 would make post-bundle
mapping a conditional guarantee — "it works if you have a build setting like
`--keep-names`" — and in configurations without that setting there would be
nothing but handlers whose contracts cannot be found. Taking neither would leave
the adapter unable to push a context without knowing the contract, and the
capabilities of a handler declaring `@entrypoint` would never be matched at run
time.

## Reconsidered: an HTTP key (the decision does not change)

The reasons for rejecting 2 above concern the case of a symbol as the key. An
HTTP entry point has another key, `method + path`, and bundlers do not rewrite
it. The question was posed again: if option 2 were rebuilt around `method + path`,
could the contract be delivered to every route with the single line
`app.use(ambitMiddleware(contracts))`, without touching existing route
registrations?

Measurements were on Node.js v24.19.0 / macOS (darwin arm64), esbuild 0.28.2,
hono 4.13.7. The spike is not left in the working tree. What was compared: (A)
the current explicit registration, (B) `ambit check --emit-contracts` emits
contract data keyed on `method + path` and one framework middleware reads it,
(C) B as the default with A only for routes the key cannot resolve.

- **Survival of the key**: under `esbuild --bundle --minify --format=esm`, all
  15/15 route path literals in the spike survived intact (including
  `/users/:email`, `/posts/:id{[0-9]+}`, `/files/*`, and `/loop/one` registered
  by looping over an array). Function declaration names were crushed to one
  character; measured `fn.name` went `listUsers`→`"a"`, `getUser`→`"u"`,
  `createOrder`→`"c"`. However, `--keep-names` is **a single flag**, not a build
  plugin, and with it every `fn.name` comes back (1213B → 1520B). So "a symbol
  key is not preserved" is a statement about defaults, and does not stand as an
  objection to a path key. The question is right on this point.
- **Whether the key is readable at run time (hono)**: inside `app.use("*")`, the
  `c.req.routePath` readable **before** `next()` returns the middleware's own
  `/*`. Since the contract must be pushed before the handler, `routePath` is not
  enough. `c.req.matchedRoutes` holds `[/*, /users/:email]` already before
  `next()`, and would serve as a key. It is a different API per framework, and is
  unverified outside hono.
- **Whether the key is determined on the static side**: walking the spike's 14
  `app.*` registrations with the TypeScript AST, a literal path is obtainable for
  12/14 (86%). The two that are not are one registered by looping over an array,
  and `app.route("/api", sub)` itself. The problem is the remaining one:
  `sub.get("/items", …)` is statically `/items` while the runtime key is
  `/api/items`. Unless mounts are resolved, the result is 11 keys that match at
  run time, **1 key that does not**, and 2 with no key. A key that does not match
  is worse than no key: that route silently falls to `runtime.unscoped`, while
  the emit side reports having covered 12/14. A gap that would be visible with no
  key is invisible here. (If the same path is also registered on the parent app,
  another route's contract could apply, but this is **unmeasured**.)
- **The proportion against `test/fixtures/realistic-api` cannot be measured**.
  The fixture has 0 `app.<method>(...)` and 0 `new Hono()`; there is no
  denominator (what it has is 7 `ambitHandler` registrations). The current
  checker has no path for extracting `method + path` either, so against an
  arbitrary application it is 0/N. The 86% above is the spike's number, not the
  fixture's.
- **Adoption cost**: across the fixture's 7 routes, `ambitHandler` registration
  accounts for 44 lines (orders 10 / users 13 / audit 21) = 6.3 lines per route.
  Putting A into an API with N existing routes costs roughly 6N lines; B costs 1
  line plus one emit step in the build/CI. This difference is a real advantage of
  B, and not a small one.

A (no change) is chosen even so. The reasons are not about key survival, but
these three:

1. **The separation of `decode` is lost.** What B wraps is the framework's
   handler itself (`(c) => …`), and inside it is `c.req.json()`. The `Context`
   API is not in the stub table, so the function that declared the contract
   contains `unknown` (`AMB-W001` / `AMB-W003`). The third parameter `decode`
   exists precisely to avoid this. Extracting a domain function restores static
   analysis, but then the key points at the route handler while the JSDoc sits on
   the domain function. B does not reduce the mapping problem; it only moves
   where it lives.
2. **Mounting makes the gap invisible.** As measured above, an extraction that
   does not resolve `app.route()` produces an `/items` counted as having a key
   statically, while the runtime key is `/api/items` and will never match. Under
   A, a route with no registration is visible from the absence of `ambitHandler`
   in the source; under B it is hidden beneath a report of full coverage. That
   runs head-on against the principle of not counting the unverifiable toward the
   guarantee (§2). Making B safe would make mount resolution a hard requirement,
   and a configuration in which `app.route()`'s arguments cannot be traced
   statically cannot meet it.
3. **There is no build-independent answer to the staleness of the generated
   artifact** (next section).

C is not taken either. C inherits 1 and 2 wholesale from B, and on top of that
adds "which to take when a registered contract and the contract data disagree".
B's one-line advantage is eroded by exactly the amount of A that has to be
written for the routes the key cannot resolve.

## The answer to contract-data staleness, were B or C to be taken

They are not taken, but they were not rejected without an answer, so it is
written down. `ambit check --emit-contracts` embeds in the contract data a
content hash (per file) of the source the contract was read from. The runtime
checks it at startup and **fails to start** if it does not match.

- `warn` is not taken. It is a state in which the static check and execution keep
  running while giving different answers about the same contract, and adding one
  line of log does not change the failure mode. This is precisely the reason 2
  was rejected.
- `deny` (pushing a deny-everything context) is not taken either. The empty set
  is a total denial, and for the same reason as the decision not to push an empty
  context for "a handler whose contract cannot be found", it makes an accident of
  build ordering indistinguishable from a policy decision.
- Failing to start is chosen because the cause of a mismatch is always a fixable
  accident — "`ambit check` was not run". Stopping execution means no progress
  until it is fixed.

This answer has a premise, though: that the source is present at startup. In a
configuration that bundles for distribution, the source is not part of the
artifact and there is nothing to check the hash against. Checking it would
require a build step carrying the hash into the artifact, and that is exactly the
coupling to the build that B was supposed to avoid. The third reason above refers
to this.

## Why `decode` is separated

A framework's `Context` API is not in Ambit's stub table. If a handler directly
contains framework calls such as `c.req.json()`, that handler contains `unknown`
(`AMB-W001` / `AMB-W003`) and the capabilities it declared end up "not fully
determined". Separating `decode` — the function building the handler's arguments
from the `Context` — into the third parameter confines framework-dependent calls
to the single registration expression, and leaves the handler that declared the
contract a framework-independent, statically analyzable function.

## Why denial is not translated into an HTTP status

`AmbitCapabilityError` / `AmbitBudgetError` are thrown to the framework's error
handler as they are. 403 means "the client lacks permission", whereas what
actually happened is "the server's code exceeded its own grant", which is a
different thing. 504 likewise claims a state of the gateway. Translating would
also bring the choice of either exposing the exception message — the list of
permitted capabilities — to the client, or dropping information in order not to.

## Why no empty context is pushed for an unmappable handler

The adapter **does not push a context with an empty capability set** for a
handler whose contract cannot be found: the empty set is a total denial, and it
would make the accident of a missing registration indistinguishable from a policy
decision. Concentrating on the single `runtime.unscoped` setting reads better
than splitting the reason for denial into two systems.
