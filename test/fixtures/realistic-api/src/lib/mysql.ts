import { createPool } from "mysql2/promise";

/**
 * The audit store, on MySQL rather than Postgres, because a real backend
 * accumulates more than one.
 *
 * `mysql2` hands out its pool through a factory, not a constructor, and the
 * fixture uses it that way because that is how the package is used. A `const`
 * bound to an imported factory's call is named by the specifier the source
 * wrote and the type the factory is declared to return — `mysql2/promise.Pool`
 * — so the calls below reach `src/stubs/data-clients.ts` the same way
 * `src/lib/db.ts`'s `new Pool(...)` does.
 */
export const auditPool = createPool({
  uri: "mysql://localhost:3306/audit",
  connectionLimit: 4,
});

export interface AuditRow {
  readonly id: string;
  readonly action: string;
}

export async function recentAuditRows(limit: number): Promise<readonly AuditRow[]> {
  const [rows] = await auditPool.query<AuditRow>("SELECT id, action FROM audit LIMIT ?", [limit]);
  return rows;
}

export async function appendAuditRow(id: string, action: string): Promise<void> {
  await auditPool.execute("INSERT INTO audit (id, action) VALUES (?, ?)", [id, action]);
}

export async function countAuditRows(): Promise<number> {
  const [rows] = await auditPool.query<{ readonly total: number }>(
    "SELECT COUNT(*) AS total FROM audit",
  );
  return rows[0]?.total ?? 0;
}
