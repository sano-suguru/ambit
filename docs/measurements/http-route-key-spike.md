# Spike: is `method + path` a usable runtime contract key?

Measured for [ADR-0007](../adr/0007-http-route-keys.md), which asked whether
contract data keyed on an HTTP `method + path` could replace explicit
registration. The conclusion is in the ADR; this is the run.

Node.js v24.19.0 / macOS (darwin arm64), esbuild 0.28.2, hono 4.13.7. The spike
itself is not left in the working tree.

## What it measured

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

## The staleness answer, had the keyed design been taken

Recorded because the alternative was not rejected without an answer to its worst
failure mode.

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
