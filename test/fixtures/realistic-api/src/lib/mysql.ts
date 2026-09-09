import { createPool } from "mysql2/promise";

/**
 * The audit store, on MySQL rather than Postgres, because a real backend
 * accumulates more than one.
 *
 * `mysql2` hands out its pool through a factory, not a constructor. Ambit
 * names a client by the class a `const` was `new`ed from, so a factory result
 * has no module-qualified name and every call through this pool is `unknown`
 * — not `pure`. `docs/status.md` records that as one of the fixture's
 * remaining unknowns rather than hiding it behind `@boundary`.
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
