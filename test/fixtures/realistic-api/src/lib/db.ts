import type { UserRecord } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";

export const pool = new Pool({ connectionString: "postgres://localhost:5432/app", max: 10 });
export const prisma = new PrismaClient();

/** @effects db_read */
export async function listUsers(): Promise<readonly UserRecord[]> {
  return prisma.user.findMany({ orderBy: { email: "asc" } });
}

/** @effects db_write */
export async function insertOrder(customerId: string, totalCents: number): Promise<void> {
  await pool.query("INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2)", [
    customerId,
    totalCents,
  ]);
}

/** @effects db_read */
export async function findOrderTotals(customerId: string): Promise<readonly number[]> {
  const result = await pool.query<{ readonly total_cents: number }>(
    "SELECT total_cents FROM orders WHERE customer_id = $1",
    [customerId],
  );
  return result.rows.map((row) => row.total_cents);
}

/**
 * The direction of an arbitrary statement is not decidable from the source, so
 * both effects have to be declared here.
 *
 * @effects db_read, db_write
 */
export async function runStatement(statement: string): Promise<void> {
  await pool.query(statement);
}
