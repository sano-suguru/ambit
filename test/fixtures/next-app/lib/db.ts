import { Pool } from "pg";

export const pool = new Pool({ connectionString: "postgres://localhost:5432/shop" });

/**
 * @effects db_write
 */
export async function insertOrder(customerId: string, totalCents: number): Promise<void> {
  await pool.query("INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2)", [
    customerId,
    totalCents,
  ]);
}

/**
 * @effects db_read
 */
export async function selectOrderTotals(customerId: string): Promise<readonly number[]> {
  const result = await pool.query<{ readonly total_cents: number }>(
    "SELECT total_cents FROM orders WHERE customer_id = $1",
    [customerId],
  );
  return result.rows.map((row) => row.total_cents);
}
