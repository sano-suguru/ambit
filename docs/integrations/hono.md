# Hono integration

`ambit-ts/runtime/hono` exports `ambitHandler`, which registers a route and
carries its contract in the same expression. It is verified against `hono@4`
and `@hono/node-server@1` — in process by `test/runtime.hono.test.ts`, through
a real server and a real socket by `test/e2e.runtime.test.ts`, and through the
installed package by `test/e2e.install.test.ts`. `hono` is a devDependency here
and the import is type-only, so the published package does not depend on it.

## Registering a route

```ts
import { Hono } from "hono";
import { ambitHandler } from "ambit-ts/runtime/hono";

const app = new Hono();

app.get("/rates", ambitHandler(
  { capabilities: ["http:get:api.example.com"], budget: { timeMs: 500 } },
  refreshRates,
  (c) => [c.req.query("currency") ?? "USD"] as const,
));
```

The `spec` is the handler's `@capabilities` and `@budget` — the checker reads
the same values the runtime enforces, on the condition that the literal `spec`
names a declaration in the same file (`docs/DESIGN.md` §4.4). `@effects` and
`@entrypoint` stay in `refreshRates`'s own JSDoc.

The third argument, `decode`, builds the handler's arguments from the request.
It is separate so that framework-dependent calls stay inside the registration
expression and the handler that declared the contract stays statically
analyzable.

## Routes registered without the adapter

A route registered with a plain `app.get("/x", handler)` establishes no Ambit
context, so nothing of its operations is checked against a capability set.
`setUnscopedPolicy("allow" | "warn" | "deny")` decides what those operations do
— `allow` by default, so adding the runtime does not break routes that have no
contracts yet. The same holds for every framework with no adapter: Express,
BullMQ, `worker_threads`, and the rest.

A handler written inline in argument position — `app.get("/x", async (c) => {
… })` — is additionally invisible to the static check: it carries no contract
of its own, and `ambit diff` reports no authority added inside it. Binding it to
a name makes it an ordinary symbol again. See
[`docs/limitations.md`](../limitations.md#what-ambit-diff-can-and-cannot-see).
