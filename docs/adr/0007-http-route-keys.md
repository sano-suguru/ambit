# ADR-0007: An HTTP `method + path` key does not replace explicit registration

- Status: Accepted
- Decides: nothing new — `docs/DESIGN.md` §4.4 stands as written
- Confirms: [ADR-0005](0005-mapping-contracts-to-handlers.md)
- Evidence: measured in a spike, recorded below. The spike is not left in the
  working tree. Node.js v24.19.0 / macOS (darwin arm64), esbuild 0.28.2,
  hono 4.13.7.

## Context

ADR-0005 rejected generated contract data on the grounds that **a symbol key
does not survive a bundler**. That reasoning covers symbol IDs and `fn.name`. It
does not cover the other key an HTTP entry point has: `method + path`, which
bundlers do not rewrite.

So the question was put again. If contract data were keyed on `method + path`,
could the contract be delivered to every route with one line —
`app.use(ambitMiddleware(contracts))` — without touching any existing route
registration? Adoption cost is where explicit registration is weakest:
`ambitHandler` costs 6.3 lines per route measured across
`test/fixtures/realistic-api`'s 7 routes, so an API with N routes pays roughly
6N lines against B's one line plus an emit step. That is a real advantage, and
not a small one.

## Decision

**Explicit registration stands unchanged.** The objection is correct on its own
terms and does not change the outcome.

## Alternatives considered

- (A) Explicit registration — the current design.
- (B) `ambit check --emit-contracts` writes contract data keyed on
  `method + path`; one framework middleware reads it.
- (C) B by default, with A only for routes whose key cannot be resolved.

## What the spike measured

- **The key survives.** Under `esbuild --bundle --minify --format=esm`, all
  15/15 route path literals survived intact, including `/users/:email`,
  `/posts/:id{[0-9]+}`, `/files/*`, and a path registered by looping over an
  array. Function names were crushed to one character (`listUsers` → `"a"`), but
  `--keep-names` is a single flag, not a build plugin, and restores every one of
  them (1213B → 1520B). **"A symbol key is not preserved" is a statement about
  defaults, and is not by itself an objection to a path key.**
- **The key is readable at run time, but not from the obvious API.** Inside
  `app.use("*")`, the `c.req.routePath` readable before `next()` returns the
  middleware's own `/*`, which is too late — the contract must be pushed before
  the handler. `c.req.matchedRoutes` already holds `[/*, /users/:email]` at that
  point and would serve. It is a different API per framework, and is unverified
  outside hono.
- **The key is not reliably determined statically.** Walking 14 `app.*`
  registrations with the TypeScript AST yields a literal path for 12 (86%).
  Worse than the two misses is the one that is wrong: `sub.get("/items", …)` is
  statically `/items` while the runtime key is `/api/items`, because
  `app.route("/api", sub)` is not resolved.
- **That 86% is the spike's number, not Ambit's.**
  `test/fixtures/realistic-api` has 0 `app.<method>(...)` and 0 `new Hono()`, so
  there is no denominator to measure against; the current checker has no path
  for extracting `method + path` at all.

## Why A is kept anyway

1. **`decode` would be lost.** What B wraps is the framework handler itself
   (`(c) => …`), whose body calls `c.req.json()`. The `Context` API is not in the
   stub table, so the function holding the contract would contain `unknown`
   (`AMB-W001` / `AMB-W003`) — exactly what `decode` exists to prevent.
   Extracting a domain function restores static analysis, but then the key points
   at the route handler while the JSDoc sits on the domain function. B does not
   reduce the mapping problem; it moves where it lives.
2. **Mounting makes the gap invisible.** The mismatched `/items` key above is
   worse than no key: that route silently falls to `runtime.unscoped` while the
   emit side reports 12/14 covered. Under A, a route with no registration is
   visible from the absence of `ambitHandler` in the source. Under B it is hidden
   beneath a report of full coverage — which is counting the unverifiable toward
   the guarantee (`docs/DESIGN.md` §2, P4). Making B safe would make mount
   resolution a hard requirement, and a configuration where `app.route()`'s
   arguments cannot be traced statically cannot meet it.
3. **Staleness has no build-independent answer** (below).

C is not taken either. It inherits 1 and 2 from B wholesale, adds "which wins
when a registered contract and the contract data disagree", and its one-line
advantage is eroded by exactly the amount of A that the unresolvable routes still
need.

## The staleness answer, had B or C been taken

B and C were not rejected without an answer to their worst failure mode, so it is
recorded. `--emit-contracts` would embed a per-file content hash of the source
each contract was read from; the runtime checks it at startup and **fails to
start** on a mismatch.

`warn` is not an option — the static check and execution would keep running while
giving different answers about the same contract, and a log line does not change
that. `deny` is not one either: an empty context is a total denial, which makes
an accident of build ordering indistinguishable from a policy decision. Failing
to start is right because the cause is always a fixable accident, "`ambit check`
was not run".

The premise is that the source is present at startup. In a configuration that
bundles for distribution it is not, and checking the hash would require a build
step carrying it into the artifact — the coupling to the build that B existed to
avoid. That is reason 3.

## Revisit when

- A framework exposes the matched route path before the handler runs, through an
  API stable enough to depend on across the frameworks Ambit supports, **and**
- mount resolution (`app.route()`) is traceable statically for the configurations
  Ambit claims to cover — without which B's coverage report can be wrong rather
  than merely incomplete.
