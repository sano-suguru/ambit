import type { KnownEffect, LiteralArgument } from "../core/index.ts";
import { sqlStatementDirection } from "../core/index.ts";

/**
 * Effect table for database and LLM client methods — the `db_read`,
 * `db_write`, and `llm` half of DESIGN.md §4.2's effect list, which nothing
 * bundled produced before this file existed. Same trust level as the other
 * bundled tables: bundled with Ambit, the highest in §8.
 *
 * Keyed on the `calleeQualifiedName` the connector layer builds for a method
 * reached through a client value: the module specifier the client's class was
 * imported from, the class name, and the property path written at the call
 * site — `pg.Pool.query`, `@prisma/client.PrismaClient.user.findMany`,
 * `openai.OpenAI.chat.completions.create`. Every part of that name comes from
 * the project's own source, not from the package's `.d.ts` internals, so a
 * hand-written `declare module "pg"` and an installed `pg` produce the same
 * key. `*` in a pattern matches exactly one segment, which is what Prisma's
 * per-model delegates need (`prisma.<model>.findMany` — the model name comes
 * from the user's schema and cannot be enumerated here).
 *
 * What this table does **not** claim: that the target of the operation is
 * known. §4.4 is explicit — "the mere existence of a hook into a DB client is
 * not taken to mean that table-level permissions can be decided for arbitrary
 * SQL" — so no row here derives a
 * `db:read:<table>` capability. Effects only.
 */
interface ClientMethodRule {
  /** `"."`-separated segments; `"*"` matches exactly one segment. */
  readonly pattern: string;
  readonly effects: readonly KnownEffect[];
}

/**
 * Both directions, for an operation whose direction the source does not fix.
 *
 * This is the conservative reading, and it is a choice with a cost: a function
 * that only ever reads, but builds its statement dynamically, has to declare
 * `db_write` too. The alternative — picking `db_read` — would let a generated
 * `UPDATE` pass a `@effects db_read` contract, which is the failure this whole
 * layer exists to prevent (DESIGN.md §3.4).
 */
const READ_AND_WRITE: readonly KnownEffect[] = ["db_read", "db_write"];

/**
 * Methods whose effect is decided by a SQL statement argument, and which
 * argument holds it. A literal statement (or a template literal whose static
 * head reaches the first keyword) is classified by that keyword; anything else
 * is {@link READ_AND_WRITE}.
 */
const SQL_STATEMENT_ARGUMENT: ReadonlyMap<string, number> = new Map([
  ["pg.Pool.query", 0],
  ["pg.Client.query", 0],
  ["pg.PoolClient.query", 0],
  ["mysql2.Pool.query", 0],
  ["mysql2.Pool.execute", 0],
  ["mysql2.Connection.query", 0],
  ["mysql2.Connection.execute", 0],
]);

const CLIENT_METHOD_RULES: readonly ClientMethodRule[] = [
  // @prisma/client — the delegate methods are the documented public API; the
  // model segment is whatever the user's schema declares.
  { pattern: "@prisma/client.PrismaClient.*.findMany", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.findFirst", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.findFirstOrThrow", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.findUnique", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.findUniqueOrThrow", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.count", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.aggregate", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.groupBy", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.*.create", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.*.createMany", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.*.update", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.*.updateMany", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.*.upsert", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.*.delete", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.*.deleteMany", effects: ["db_write"] },
  // Prisma splits raw access by direction itself, so no statement inspection
  // is needed: `$queryRaw` is for `SELECT`, `$executeRaw` for everything else.
  { pattern: "@prisma/client.PrismaClient.$queryRaw", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.$queryRawUnsafe", effects: ["db_read"] },
  { pattern: "@prisma/client.PrismaClient.$executeRaw", effects: ["db_write"] },
  { pattern: "@prisma/client.PrismaClient.$executeRawUnsafe", effects: ["db_write"] },
  // A transaction's callback is not walked from here, and its statements are
  // whatever the caller put in it.
  { pattern: "@prisma/client.PrismaClient.$transaction", effects: READ_AND_WRITE },
  // openai — both the named and the default export are in use in the wild, so
  // both spellings of the class key are listed.
  { pattern: "openai.OpenAI.chat.completions.create", effects: ["llm"] },
  { pattern: "openai.default.chat.completions.create", effects: ["llm"] },
  { pattern: "openai.OpenAI.responses.create", effects: ["llm"] },
  { pattern: "openai.default.responses.create", effects: ["llm"] },
  { pattern: "openai.OpenAI.embeddings.create", effects: ["llm"] },
  { pattern: "openai.default.embeddings.create", effects: ["llm"] },
  // @anthropic-ai/sdk
  { pattern: "@anthropic-ai/sdk.Anthropic.messages.create", effects: ["llm"] },
  { pattern: "@anthropic-ai/sdk.default.messages.create", effects: ["llm"] },
];

/**
 * The effects of a database or LLM client call, or `undefined` when this table
 * says nothing about it — which leaves the call `unknown`, never "no effect".
 *
 * `literalArguments` is what the connector layer could read at the call site;
 * it decides the direction for the SQL-statement methods above.
 */
export function lookupClientEffects(
  qualifiedName: string,
  literalArguments: readonly (LiteralArgument | undefined)[] | undefined,
): readonly KnownEffect[] | undefined {
  const statementArgument = SQL_STATEMENT_ARGUMENT.get(qualifiedName);
  if (statementArgument !== undefined) {
    return sqlStatementEffects(literalArguments?.[statementArgument]);
  }
  for (const rule of CLIENT_METHOD_RULES) {
    if (patternMatches(rule.pattern, qualifiedName)) return rule.effects;
  }
  return undefined;
}

/**
 * The direction of one SQL statement, as effects. The keyword rule itself is
 * `src/core/sql.ts`, shared with the runtime `pg` hook so the checker and the
 * running process cannot disagree about the same statement (DESIGN.md §4.4).
 */
function sqlStatementEffects(argument: LiteralArgument | undefined): readonly KnownEffect[] {
  switch (sqlStatementDirection(argument?.text)) {
    case "read":
      return ["db_read"];
    case "write":
      return ["db_write"];
    default:
      return READ_AND_WRITE;
  }
}

function patternMatches(pattern: string, qualifiedName: string): boolean {
  if (pattern === qualifiedName) return true;
  if (!pattern.includes("*")) return false;
  const patternSegments = pattern.split(".");
  const nameSegments = qualifiedName.split(".");
  if (patternSegments.length !== nameSegments.length) return false;
  return patternSegments.every(
    (segment, index) => segment === "*" || segment === nameSegments[index],
  );
}
