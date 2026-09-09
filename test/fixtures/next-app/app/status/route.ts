/**
 * An Edge route, deliberately left unwrapped.
 *
 * `export const runtime = "edge"` opts this route out of the Node.js runtime,
 * and with it out of everything `ambitRoute` depends on: the hooks
 * (`installFetchHook` and the rest) are installed from `instrumentation.ts`'s
 * `register()`, which does not run on Edge, and there is no
 * `node:async_hooks`-backed context to establish. Wrapping this handler would
 * produce a registration that reads as enforced and is not — DESIGN.md §12
 * 「エッジランタイム」 guarantees Node.js only in Phase 1 — so it is written
 * the plain Next.js way, with no contract and no `@entrypoint`.
 */
export const runtime = "edge";

export function GET(): Response {
  return Response.json({ ok: true });
}
