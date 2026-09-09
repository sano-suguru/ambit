import type { Context, Env, Handler, Input } from "hono";
import type { AmbitSpec } from "./index.ts";
import { withAmbit } from "./index.ts";

/**
 * The Hono adapter (DESIGN.md §4.4「契約とハンドラの対応付け（決定）」).
 *
 * `hono` is imported for **types only** and is a devDependency here, never a
 * dependency of the published package — the same reason `installPgHook(pg)`
 * takes the module from the caller instead of importing `pg` (§4.4 (c)).
 * Nothing in this file imports `typescript` or anything under `src/checker/`.
 */

/**
 * Register a contract-bearing handler on a Hono route, establishing the
 * entrypoint's capability set and budget for the whole request.
 *
 * ```ts
 * app.post("/orders", ambitHandler(
 *   { capabilities: ["db:write:orders"], budget: { timeMs: 800 } },
 *   createOrder,
 *   async (c) => [await c.req.json<CreateOrderInput>()] as const,
 * ));
 * ```
 *
 * The three arguments are the decision §4.4 records, not a convenience:
 *
 * - `spec` sits in the same call as `handler`, so a literal one *is* that
 *   handler's `@capabilities` and `@budget`: the tags need not repeat what the
 *   registration already says. Where both are written, `ambit check` compares
 *   them — the capability list against `@capabilities` (`AMB-E010`), and
 *   `spec.budget` against `@budget` (`AMB-E011`, with an omitted `onExceed`
 *   defaulted to `throw` on both sides) — and a disagreement is an error. The
 *   two halves are judged independently: a spec may write one as a literal and
 *   build the other at runtime, and `AMB-W004` reports whichever half could
 *   neither declare nor be compared, where the handler's own JSDoc is then the
 *   only declaration. Explicit registration was chosen over generated contract
 *   data because the contract is then a value in the module — it survives a
 *   build that strips comments, and a bundler that renames everything.
 * - `decode` keeps the framework out of `handler`. Hono's `Context` is in no
 *   stub table, so a `c.req.json()` inside a contract-bearing function would
 *   make that function's requirement partly `unknown` (`AMB-W003`). Isolated
 *   here, the handler stays framework-agnostic and statically analyzable.
 *   It runs **inside** the context: reading the request body counts toward
 *   `timeMs`.
 *
 * `AmbitCapabilityError` and `AmbitBudgetError` are **not** translated into
 * HTTP statuses. A denied capability is this server's own code exceeding its
 * grant, which is not what 403 says, and the message names the granted set —
 * so it goes to the framework's error handler, not to the client (§4.4).
 *
 * A handler registered without this adapter establishes no context at all;
 * what its operations do then is `setUnscopedPolicy`'s decision (`allow` by
 * default). The adapter never invents an empty-capability context for a route
 * it was not given, because a deny-everything context is indistinguishable
 * from a missed registration.
 */
export function ambitHandler<
  Args extends readonly unknown[],
  Result,
  E extends Env = Env,
  P extends string = string,
  I extends Input = Input,
>(
  spec: AmbitSpec,
  handler: (...args: Args) => Result | Promise<Result>,
  decode: (c: Context<E, P, I>) => readonly [...Args] | Promise<readonly [...Args]>,
): Handler<E, P, I> {
  const scoped = withAmbit(spec, async (c: Context<E, P, I>) =>
    // `decode` may return a `readonly` tuple — `[x] as const` is what a caller
    // naturally writes — and a readonly tuple spreads into rest parameters.
    handler(...(await decode(c))),
  );

  return async (c) => {
    const result = await scoped(c);
    // `Response.json` rather than `c.json`: the handler's return type is the
    // domain's, not Hono's `JSONValue`, and forcing it through that generic
    // would mean casting every handler. The cost is that Hono's RPC type
    // inference (`hc`) sees `Response`, not the handler's shape —
    // `docs/limitations.md` records it.
    return result instanceof Response ? result : Response.json(result ?? null);
  };
}
