import { withAmbit } from "ambit/runtime";
import { pluralize, summaryLine } from "../domain/format.ts";
import { auditSize, auditTrail, classifyRisk, record } from "../lib/index.ts";

/**
 * @entrypoint
 * @capabilities db:read:audit
 * @effects db_read
 * @budget timeMs=1500
 */
export async function listAudit(limit: number): Promise<readonly string[]> {
  const rows = await auditTrail(limit);
  return rows.map((row) => summaryLine(row.action, row.id.length));
}

export const LIST_AUDIT = withAmbit(
  { capabilities: ["db:read:audit"], budget: { timeMs: 1500 } },
  listAudit,
);

/**
 * @entrypoint
 * @capabilities db:write:audit
 * @effects db_write
 * @budget timeMs=1000 onExceed=warn
 */
export async function writeAudit(id: string, action: string): Promise<string> {
  await record(id, action);
  const total = await auditSize();
  return `${total} ${pluralize(total, "entry", "entries")}`;
}

export const WRITE_AUDIT = withAmbit(
  { capabilities: ["db:write:audit"], budget: { timeMs: 1000, onExceed: "warn" } },
  writeAudit,
);

/**
 * @entrypoint
 * @capabilities db:read:audit
 * @effects db_read, llm
 * @budget timeMs=5000 llmCalls=1 onExceed=throw
 */
export async function reviewAudit(limit: number): Promise<string> {
  const rows = await auditTrail(limit);
  return classifyRisk(rows.map((row) => row.action).join(", "));
}

export const REVIEW_AUDIT = withAmbit(
  {
    capabilities: ["db:read:audit"],
    budget: { timeMs: 5000, llmCalls: 1, onExceed: "throw" },
  },
  reviewAudit,
);
