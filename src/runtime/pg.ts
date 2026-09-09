import { sqlStatementDirection } from "../core/index.ts";
import { checkCapabilities } from "./enforce.ts";

/**
 * Runtime enforcement for the `pg` client (DESIGN.md §4.4 (a), (c)).
 *
 * Unlike the `node:` builtins this is a **client wrap**, not a global
 * monkeypatch: Ambit does not depend on `pg`, so the caller hands the module
 * in — `installPgHook(await import("pg"))` — and Ambit replaces
 * `Pool.prototype.query` and `Client.prototype.query`. `pg` was chosen over
 * `@prisma/client` because those prototypes give install and restore the same
 * symmetry `installFetchHook` has, while Prisma's only stable extension point
 * (`$extends`) returns a *new* client and so cannot be undone (P5).
 *
 * What this does **not** do: derive a table from the statement. §4.4 is
 * explicit — 「DB クライアントへのフックの存在だけで、任意の SQL のテーブル
 * 単位権限を判定できるとみなさない」 — so the target is the database the
 * connection names, and the exception says so rather than leaving the reader
 * to assume table granularity.
 */

/** The `pg` surface this hook needs. Structural, so a test double satisfies it. */
export interface PgModule {
  readonly Pool?: { readonly prototype: object };
  readonly Client?: { readonly prototype: object };
}

const TARGET_DETAIL =
  "the target is the database this connection names, not a table: Ambit does not read table names out of arbitrary SQL";

const UNKNOWN_DATABASE_DETAIL =
  "the connection does not name a database, so the target could not be determined; only a grant that does not name one (db:read:*) can cover it";

const OPAQUE_STATEMENT_DETAIL =
  "the statement's direction is not decidable from this call, so both db:read and db:write are required";

/**
 * The capabilities one `query` requires, given the client it was called on and
 * the arguments it was called with.
 *
 * Direction comes from `sqlStatementDirection` in `src/core/`, the same rule
 * the static effect table uses — §4.4 (c) puts it in one place so the checker
 * and the running process cannot answer differently about one statement.
 */
export function pgCapabilities(
  client: unknown,
  args: readonly unknown[],
): { readonly capabilities: readonly string[]; readonly detail: string } {
  const database = databaseOf(client);
  const target = database ?? "unknown";
  const direction = sqlStatementDirection(statementText(args[0]));

  const capabilities =
    direction === "read"
      ? [`db:read:${target}`]
      : direction === "write"
        ? [`db:write:${target}`]
        : [`db:read:${target}`, `db:write:${target}`];

  const notes = [TARGET_DETAIL];
  if (database === undefined) notes.push(UNKNOWN_DATABASE_DETAIL);
  if (direction === "both") notes.push(OPAQUE_STATEMENT_DETAIL);
  return { capabilities, detail: notes.join("; ") };
}

/**
 * `undefined` when the statement is not a string this call fixes — a
 * `Submittable` (a cursor, say), or a config object with no `text`. That is
 * not "no statement": it is "the direction is not decidable", which
 * {@link pgCapabilities} turns into both directions.
 */
function statementText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const text = (value as { text?: unknown }).text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

/**
 * The database a `pg` client is connected to, or `undefined` when the client
 * does not name one — an environment-only configuration, or a
 * `connectionString` with no path. Each of the shapes below is somewhere `pg`
 * actually keeps it (`Pool#options`, `Client#connectionParameters`, and the
 * `database` a connected client exposes).
 */
function databaseOf(client: unknown): string | undefined {
  if (client === null || typeof client !== "object") return undefined;
  const record = client as Record<string, unknown>;
  for (const source of [record, record.options, record.connectionParameters]) {
    if (source === null || typeof source !== "object") continue;
    const config = source as Record<string, unknown>;
    const database = config.database;
    if (typeof database === "string" && database.length > 0) return database;
    const fromUrl = databaseFromConnectionString(config.connectionString);
    if (fromUrl !== undefined) return fromUrl;
  }
  return undefined;
}

function databaseFromConnectionString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const name = new URL(value).pathname.replace(/^\//, "");
    return name.length > 0 ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

type AnyFunction = (...args: unknown[]) => unknown;

/**
 * Wrap `Pool.prototype.query` and `Client.prototype.query` on the `pg` module
 * handed in, returning the function that restores both.
 *
 * `query` is promise-returning unless a callback is passed, so a denial
 * rejects, or reaches the callback through `process.nextTick` when there is
 * one — §4.4 (a)'s rule for each family.
 */
export function installPgHook(pg: PgModule): () => void {
  const restores: (() => void)[] = [];
  for (const clientClass of [pg.Pool, pg.Client]) {
    const prototype = clientClass?.prototype as Record<string, unknown> | undefined;
    if (!prototype) continue;
    const original = prototype.query;
    if (typeof original !== "function") continue;
    const target = original as AnyFunction;

    const hooked = function (this: unknown, ...args: unknown[]): unknown {
      const { capabilities, detail } = pgCapabilities(this, args);
      const error = checkCapabilities(capabilities, detail);
      if (!error) return target.apply(this, args);
      const callback = args[args.length - 1];
      if (typeof callback === "function") {
        process.nextTick(callback as AnyFunction, error);
        return undefined;
      }
      return Promise.reject(error);
    };
    Object.defineProperty(hooked, "name", { value: "query" });
    prototype.query = hooked;
    restores.push(() => {
      if (prototype.query === hooked) prototype.query = original;
    });
  }

  return () => {
    for (const restore of restores) restore();
  };
}
