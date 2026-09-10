/**
 * An Edge route, deliberately left unwrapped.
 *
 * `export const runtime = "edge"` opts this route out of the Node.js runtime,
 * and with it out of the hooks `ambitRoute` depends on: they are Node.js hooks
 * installed from `instrumentation.ts`'s `register()`, which installs nothing
 * when `NEXT_RUNTIME` is not `nodejs`. Wrapping this handler would produce a
 * registration that reads as enforced and is not — DESIGN.md §12, "Edge
 * runtimes", guarantees Node.js only in Phase 1 — so it is written
 * the plain Next.js way, with no contract and no `@entrypoint`.
 */
export const runtime = "edge";

export function GET(): Response {
  return Response.json({ ok: true });
}
