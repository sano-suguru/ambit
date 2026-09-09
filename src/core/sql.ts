/**
 * The direction of one SQL statement, read from its leading keyword.
 *
 * Lives in `src/core/` because DESIGN.md §4.4 requires the static side
 * (`src/stubs/data-clients.ts`, which turns the direction into `db_read` /
 * `db_write` effects) and the runtime `pg` hook (which turns it into a
 * `db:read:` / `db:write:` capability) to use *the same rule*. Two copies
 * would let the checker and the running process give different answers about
 * the same statement, which is the worst outcome available here.
 */
export type SqlDirection = "read" | "write" | "both";

/** Leading SQL keywords that only read. `WITH` is deliberately absent: a CTE can wrap an `INSERT`. */
const READ_KEYWORDS: ReadonlySet<string> = new Set(["select", "show", "explain", "describe"]);

const WRITE_KEYWORDS: ReadonlySet<string> = new Set([
  "insert",
  "update",
  "delete",
  "replace",
  "merge",
  "upsert",
  "create",
  "drop",
  "alter",
  "truncate",
  "grant",
  "revoke",
]);

/**
 * `"both"` — not a guess at the likelier direction — whenever the leading
 * keyword is not present or not recognised. Picking `read` would let a
 * generated `UPDATE` pass a read-only contract, which is the failure this
 * layer exists to prevent (DESIGN.md §3.4).
 *
 * A template literal's static head is enough for the static side: the keyword
 * that decides the direction is written before any substitution, or it is not
 * statically present at all — and then the answer is `"both"`.
 */
export function sqlStatementDirection(text: string | undefined): SqlDirection {
  if (text === undefined) return "both";
  const keyword = /^[\s(]*([a-z]+)/i.exec(text)?.[1]?.toLowerCase();
  if (keyword === undefined) return "both";
  if (READ_KEYWORDS.has(keyword)) return "read";
  if (WRITE_KEYWORDS.has(keyword)) return "write";
  return "both";
}
