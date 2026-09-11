// `next/server.js`, not `next/server`: `next` publishes no `exports` map, and
// under this repository's `module: NodeNext` a bare package subpath without one
// resolves with no extension search — `next/server` is TS2307 here. The import
// is erased (`import type` + `verbatimModuleSyntax`), so the specifier is this
// file's type-resolution detail only; a consumer on `moduleResolution: bundler`
// writes `next/server` in their own route as Next's documentation shows.
import type { NextRequest } from "next/server.js";
import type { AmbitSpec } from "./index.ts";
import { withAmbit } from "./index.ts";

/**
 * The Next.js App Router adapter (DESIGN.md §4.4, "Mapping contracts to
 * handlers").
 *
 * `next` is imported for **types only** and is a devDependency here, never a
 * dependency of the published package — the same treatment `hono` gets in
 * `./hono.ts`, and the same reason `installPgHook(pg)` takes the module from
 * the caller instead of importing `pg` (§4.4 (c)). Nothing in this file
 * imports `typescript` or anything under `src/checker/`.
 *
 * **What this adapter does not reach.** It covers one thing: a Route Handler
 * exported from `app/**\/route.ts` and registered through {@link ambitRoute},
 * running on the Node.js runtime. It establishes no context for, and enforces
 * nothing in:
 *
 * - a route that sets `export const runtime = "edge"` — the hooks
 *   (`installFetchHook` and friends) are Node.js hooks and are not installed
 *   there, so no capability is checked on such a route. Nothing else about
 *   `ambitRoute` on Edge is claimed either: no test runs there. docs/open-questions.md
 *   "Edge runtimes": Phase 1 guarantees Node.js only.
 * - Server Actions (`"use server"`), which are not route modules and have no
 *   registration call to attach a spec to.
 * - `middleware.ts`, which runs on the Edge runtime and outside any route
 *   module.
 * - the Pages Router (`pages/api/*`), which has a different handler shape.
 *
 * Reaching any of those is out of scope for this adapter, not something it
 * silently half-covers: with no `ambitRoute` registration there is no context
 * at all, and what an operation does then is `setUnscopedPolicy`'s decision
 * (`allow` by default).
 */

/**
 * The second argument Next.js passes a Route Handler: the matched dynamic
 * segments. Declared here rather than imported because Next.js generates the
 * per-route version into `.next/types/`, which does not exist in a repository
 * that never runs `next build`.
 */
export interface RouteContext<
  Params extends Record<string, string | readonly string[]> = Record<
    string,
    string | readonly string[]
  >,
> {
  /** A Promise since Next.js 15; `await`ed inside the context by `decode`. */
  readonly params: Promise<Params>;
}

/**
 * The shape Next.js expects `export const GET = …` in `app/**\/route.ts` to
 * have.
 */
export type RouteHandler<
  Params extends Record<string, string | readonly string[]> = Record<
    string,
    string | readonly string[]
  >,
> = (request: NextRequest, context: RouteContext<Params>) => Promise<Response>;

/**
 * Register a contract-bearing handler as a Next.js Route Handler,
 * establishing the entrypoint's capability set and budget for the whole
 * request.
 *
 * ```ts
 * // app/orders/route.ts
 * export const POST = ambitRoute(
 *   { capabilities: ["db:write:orders"], budget: { timeMs: 800 } },
 *   createOrder,
 *   async (request) => [await request.json() as CreateOrderInput] as const,
 * );
 * ```
 *
 * `spec` and `handler` are in the **same first two positions** as
 * {@link ambitHandler}'s, and that is load-bearing rather than cosmetic:
 * `RUNTIME_WRAPPER_NAMES` in `src/checker/backend/legacy-ts.ts` reads
 * `arguments[0]` as the spec and `arguments[1]` as the handler for every
 * registered wrapper, so one extraction serves all of them. Changing the order
 * here would cost the check without saying so.
 *
 * Per §4.4, "Removing the double declaration", a literal `spec` beside a
 * handler declared in the same file *is* that handler's `@capabilities` and
 * `@budget`: the JSDoc tags need not repeat it. Writing both stays legal, and
 * a disagreement is still an error — the capability list against
 * `@capabilities` (`AMB-E010`) and `spec.budget` against `@budget`
 * (`AMB-E011`).
 *
 * `decode` keeps the framework out of `handler`, exactly as in the Hono
 * adapter: `NextRequest` is in no stub table, so a `request.json()` inside a
 * contract-bearing function would make that function's requirement partly
 * `unknown` (`AMB-W003`). It runs **inside** the context, so reading the
 * request body and awaiting `context.params` count toward `timeMs`.
 *
 * `AmbitCapabilityError` and `AmbitBudgetError` are **not** translated into
 * HTTP statuses. A denied capability is this server's own code exceeding its
 * grant, which is not what 403 says, and the message names the granted set —
 * so it propagates out of the handler to Next.js's error handling, not to the
 * client (§4.4).
 *
 * The hooks this enforcement depends on are installed once per process, in
 * `instrumentation.ts`'s `register()` — see `docs/integrations/nextjs.md`.
 * Without them, `ambitRoute` still establishes the context and applies
 * `timeMs`, but no capability is checked, because nothing is intercepting the
 * operations.
 */
export function ambitRoute<
  Args extends readonly unknown[],
  Result,
  Params extends Record<string, string | readonly string[]> = Record<
    string,
    string | readonly string[]
  >,
>(
  spec: AmbitSpec,
  handler: (...args: Args) => Result | Promise<Result>,
  decode: (
    request: NextRequest,
    context: RouteContext<Params>,
  ) => readonly [...Args] | Promise<readonly [...Args]>,
): RouteHandler<Params> {
  const scoped = withAmbit(spec, async (request: NextRequest, context: RouteContext<Params>) =>
    // `decode` may return a `readonly` tuple — `[x] as const` is what a caller
    // naturally writes — and a readonly tuple spreads into rest parameters.
    handler(...(await decode(request, context))),
  );

  return async (request, context) => {
    const result = await scoped(request, context);
    // `Response.json` rather than `NextResponse.json`: the handler's return
    // type is the domain's, and `NextResponse` adds nothing a Route Handler
    // needs here. Next.js accepts any `Response`.
    return result instanceof Response ? result : Response.json(result ?? null);
  };
}
