# ADR-0007: An HTTP `method + path` key does not replace explicit registration

- Status: Accepted
- Decides: nothing new — `docs/DESIGN.md` §4.4 stands as written
- Confirms: [ADR-0005](0005-mapping-contracts-to-handlers.md)
- Evidence: [`docs/measurements/http-route-key-spike.md`](../measurements/http-route-key-spike.md)

## Context

ADR-0005 rejected generated contract data because **a symbol key does not
survive a bundler**. That covers symbol IDs and `fn.name`. It does not cover the
other key an HTTP entry point has: `method + path`, which bundlers do not
rewrite.

The question was worth reopening because adoption cost is where explicit
registration is weakest: `ambitHandler` costs 6.3 lines per route (measured over
`test/fixtures/realistic-api`'s 7 routes), so an API with N routes pays roughly
6N lines against one line of middleware plus an emit step.

## Decision

**Explicit registration stands unchanged.** The objection is correct on its own
terms and does not change the outcome.

## Why

1. **`decode` would be lost.** A middleware wraps the framework handler itself,
   whose body calls `c.req.json()`. The `Context` API is not in the stub table,
   so the function holding the contract would contain `unknown` — exactly what
   `decode` exists to prevent. Extracting a domain function restores static
   analysis, but then the key points at the route handler while the JSDoc sits on
   the domain function: the mapping problem moves rather than shrinks.
2. **Mounting makes the gap invisible.** Static route resolution is incomplete:
   the spike found `sub.get("/items", …)` reads statically as `/items` while the
   runtime key is `/api/items`, because `app.route("/api", sub)` is not resolved.
   That route would silently fall to `runtime.unscoped` while the emit side
   reported it covered — counting the unverifiable toward the guarantee (P4).
   Under explicit registration a route with no registration is visible from the
   absence of `ambitHandler` in the source.
3. **Staleness has no build-independent answer.** The only honest one is a
   content hash checked at startup, which requires the source to be present
   there; in a bundled distribution it is not, so the check would need the build
   step the design existed to avoid. The full answer is in the spike record.

## Alternatives rejected

- **Middleware reading `--emit-contracts` data keyed on `method + path`** — the
  three reasons above.
- **That, with explicit registration only for unresolvable routes.** Inherits
  reasons 1 and 2 whole, adds "which wins when a registered contract and the
  generated data disagree", and its one-line advantage is eroded by exactly the
  amount of explicit registration the unresolvable routes still need.

## Revisit when

- A framework exposes the matched route path before the handler runs, through an
  API stable enough to depend on across the frameworks Ambit supports, **and**
- mount resolution (`app.route()`) is traceable statically for the
  configurations Ambit claims to cover — without which the coverage report can
  be wrong rather than merely incomplete.
