# Next.js integration

`ambit-ts/runtime/next` reaches exactly one thing: an App Router **Route Handler**
in `app/**/route.ts`, on the **Node.js runtime**, registered through
`ambitRoute`. Everything else on this page is about what that sentence excludes.

## Registering a Route Handler

`app/**/route.ts` exports one function per HTTP method, so the contract goes in
the `ambitRoute` call the method is assigned from:

```ts
// app/rates/route.ts
import { ambitRoute } from "ambit-ts/runtime/next";

/**
 * @entrypoint
 * @effects network
 */
async function currentRate(currency: string): Promise<{ readonly rate: number }> {
  const response = await fetch(`https://api.example.com/rates?base=${currency}`);
  return (await response.json()) as { readonly rate: number };
}

export const GET = ambitRoute(
  { capabilities: ["http:get:api.example.com"], budget: { timeMs: 500 } },
  currentRate,
  (request) => [request.nextUrl.searchParams.get("base") ?? "USD"] as const,
);
```

The third argument, `decode`, builds the handler's arguments from the request. It
is separate so that framework-dependent calls stay inside the registration
expression and the handler that declared the contract stays statically
analyzable — see `docs/DESIGN.md` §4.4.

## Installing the hooks

The hooks have to be installed once per server process, before any route runs.
Next.js has one place for that — `instrumentation.ts` at the project root, whose
`register()` it calls once at startup:

```ts
// instrumentation.ts
import {
  installChildProcessHook,
  installFetchHook,
  installFsHook,
} from "ambit-ts/runtime";

export function register(): void {
  // `register()` runs on the Edge runtime too, where none of these hooks
  // apply — `node:fs` and `node:child_process` do not exist there and nothing
  // would be enforced. The Node.js runtime is the only one that gets them.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  installFetchHook();
  installFsHook();
  installChildProcessHook();
}
```

`installPgHook(pg)` goes there too where the app uses `pg`; it takes the module
from the caller rather than importing it, so it is left out above to keep the
snippet dependency-free.

## What is covered

| Next.js execution path | Covered |
|---|---|
| `app/**/route.ts` Route Handler, Node.js runtime, registered with `ambitRoute` | yes |
| the same route with `export const runtime = "edge"` | no — no hook is installed there |
| Server Actions (`"use server"`) | no — not a route module, no registration call to carry a `spec` |
| `middleware.ts` | no — runs on the Edge runtime, outside every route module |
| Pages Router (`pages/api/*`) | no — a different handler shape, and no adapter for it |

A route on an uncovered path establishes no Ambit context at all.
`setUnscopedPolicy("allow" | "warn" | "deny")` decides what its operations do,
`allow` by default. Such a route is not broken by any of this; it is simply
unenforced, exactly as it was before Ambit was added.

## The Edge runtime

**A route on the Edge runtime is not enforced.** `export const runtime = "edge"`
takes the route off Node.js, and every hook Ambit installs is a Node.js one —
`node:fs` and `node:child_process` do not exist there, and the `register()` above
deliberately installs nothing when `NEXT_RUNTIME` is not `nodejs`, so **no
capability is checked** on such a route: nothing is intercepting the operations.

Nothing else about `ambitRoute` on Edge is claimed either — no test runs there,
so whether the context is established at all is unverified. Phase 1 guarantees
the Node.js runtime only (`docs/DESIGN.md` §12, "Edge runtimes").

The honest form for an Edge route today is to leave it unwrapped, so that nothing
about it reads as enforced.
