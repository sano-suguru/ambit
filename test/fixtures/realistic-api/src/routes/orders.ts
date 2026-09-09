import { ambitHandler } from "ambit/runtime/hono";
import type { Context } from "hono";
import type { CreateOrderInput } from "../domain/model.ts";
import { subtotal, taxFor } from "../domain/tax.ts";
import { validateOrder } from "../domain/validate.ts";
import { insertOrder, pool } from "../lib/index.ts";

export interface CreatedOrder {
  readonly status: number;
  readonly totalCents: number;
}

/**
 * @entrypoint
 * @capabilities db:write:orders
 * @effects db_write
 * @budget timeMs=800 onExceed=throw
 */
export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const issues = validateOrder(input);
  if (issues.length > 0) return { status: 422, totalCents: 0 };
  const base = subtotal(input.lines);
  const totalCents = base + taxFor(base, 8);
  await insertOrder(input.customerId, totalCents);
  return { status: 201, totalCents };
}

export const POST = ambitHandler(
  { capabilities: ["db:write:orders"], budget: { timeMs: 800, onExceed: "throw" } },
  createOrder,
  async (c: Context) => [await c.req.json<CreateOrderInput>()] as const,
);

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects db_read
 * @budget timeMs=500
 */
export async function listOrderTotals(customerId: string): Promise<readonly number[]> {
  const result = await pool.query<{ readonly total_cents: number }>(
    "SELECT total_cents FROM orders WHERE customer_id = $1",
    [customerId],
  );
  return result.rows.map((row) => row.total_cents);
}

export const GET = ambitHandler(
  { capabilities: ["db:read:orders"], budget: { timeMs: 500 } },
  listOrderTotals,
  (c: Context) => [c.req.param("customerId") ?? ""] as const,
);
