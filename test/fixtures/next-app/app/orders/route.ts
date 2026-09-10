import { ambitRoute } from "ambit/runtime/next";
import type { CreateOrderInput } from "../../domain/model.ts";
import { subtotal, taxFor } from "../../domain/tax.ts";
import { insertOrder, selectOrderTotals } from "../../lib/db.ts";

/**
 * The App Router shape: `app/orders/route.ts` exports one function per HTTP
 * method. The handler itself is a plain module-local function — Next.js only
 * accepts the method names and its segment config as exports of a route
 * module — and the contract lives in the `ambitRoute` call beside it.
 *
 * Neither handler writes `@capabilities` or `@budget`: the literal `spec` is
 * the declaration (DESIGN.md §4.4, "Removing the double declaration").
 */

/**
 * @entrypoint
 * @effects db_write
 */
async function createOrder(input: CreateOrderInput): Promise<{ readonly totalCents: number }> {
  const base = subtotal(input.lines);
  const totalCents = base + taxFor(base, 8);
  await insertOrder(input.customerId, totalCents);
  return { totalCents };
}

export const POST = ambitRoute(
  { capabilities: ["db:write:shop"], budget: { timeMs: 800, onExceed: "throw" } },
  createOrder,
  async (request) => [await request.json<CreateOrderInput>()] as const,
);

/**
 * @entrypoint
 * @effects db_read
 */
async function listOrderTotals(customerId: string): Promise<readonly number[]> {
  return selectOrderTotals(customerId);
}

export const GET = ambitRoute(
  { capabilities: ["db:read:shop"], budget: { timeMs: 500 } },
  listOrderTotals,
  (request) => [request.nextUrl.searchParams.get("customerId") ?? ""] as const,
);
