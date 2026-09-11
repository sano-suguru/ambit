import type { AuditRow } from "./mysql.ts";
import { appendAuditRow, countAuditRows, recentAuditRows } from "./mysql.ts";

/**
 * The audit layer over the MySQL pool. Nothing here declares a contract, so
 * each function's authority is whatever `mysql.ts` produces, inherited one hop
 * — which is what makes the routes above it a propagation test rather than a
 * direct one.
 */

export async function auditTrail(limit: number): Promise<readonly AuditRow[]> {
  return recentAuditRows(limit);
}

export async function record(id: string, action: string): Promise<void> {
  await appendAuditRow(id, action);
}

export async function auditSize(): Promise<number> {
  return countAuditRows();
}
