import { ambitRoute } from "ambit/runtime/next";
import { selectOrderTotals } from "../../../lib/db.ts";

/**
 * A dynamic segment. `context.params` is a Promise since Next.js 15, and it is
 * awaited inside `decode`, which runs inside the entrypoint context — so the
 * await counts toward `timeMs` like every other part of the request.
 */

/**
 * @entrypoint
 * @effects db_read
 */
async function orderTotal(id: string): Promise<{ readonly totalCents: number }> {
  const totals = await selectOrderTotals(id);
  return { totalCents: totals[0] ?? 0 };
}

export const GET = ambitRoute<readonly [string], { readonly totalCents: number }, { id: string }>(
  { capabilities: ["db:read:shop"], budget: { timeMs: 500 } },
  orderTotal,
  async (_request, context) => [(await context.params).id] as const,
);
