import type { AuditRow } from "./mysql.ts";
import { appendAuditRow, countAuditRows, recentAuditRows } from "./mysql.ts";

/**
 * The audit layer over the MySQL pool. Every function here reaches a call
 * Ambit cannot resolve (see `mysql.ts`), so none of them may claim `pure`.
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
