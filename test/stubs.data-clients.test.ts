import { describe, expect, it } from "vitest";
import type { LiteralArgument } from "../src/core/index.ts";
import { lookupClientEffects } from "../src/stubs/data-clients.ts";

/**
 * The database/LLM effect table (DESIGN.md §4.2, `src/stubs/data-clients.ts`).
 *
 * Every row family in that table is exercised here rather than only the ones
 * `test/fixtures/realistic-api` happens to call: a row nothing checks is an
 * unverified claim about a library's API, and a wrong *direction* on a row
 * would let a generated write pass a read-only contract.
 */

function literal(text: string): readonly (LiteralArgument | undefined)[] {
  return [{ text, complete: true }];
}

function templatePrefix(text: string): readonly (LiteralArgument | undefined)[] {
  return [{ text, complete: false }];
}

describe("lookupClientEffects", () => {
  it("says nothing about a name it does not know", () => {
    // The whole safety property: a miss leaves the call `unknown`, never "no
    // effect" (DESIGN.md §3.4).
    expect(lookupClientEffects("pg.Pool.end", undefined)).toBeUndefined();
    expect(lookupClientEffects("mysql2.Pool.release", undefined)).toBeUndefined();
    expect(
      lookupClientEffects("openai.OpenAI.chat.completions.retrieve", undefined),
    ).toBeUndefined();
  });

  describe("SQL statement direction", () => {
    it("reads a literal statement's leading keyword", () => {
      expect(lookupClientEffects("pg.Pool.query", literal("SELECT id FROM users"))).toEqual([
        "db_read",
      ]);
      expect(
        lookupClientEffects("pg.Pool.query", literal("INSERT INTO orders (id) VALUES ($1)")),
      ).toEqual(["db_write"]);
      expect(lookupClientEffects("pg.Client.query", literal("  update users set x = 1"))).toEqual([
        "db_write",
      ]);
      expect(lookupClientEffects("mysql2.Connection.execute", literal("DELETE FROM t"))).toEqual([
        "db_write",
      ]);
    });

    it("covers `mysql2/promise`, whose clients come from a factory rather than a constructor", () => {
      // `mysql2@3.15.3/promise.d.ts`: `createPool(config): Pool` and
      // `createConnection(config): Promise<Connection>`, with `interface Pool
      // extends Connection`. The receiver is named from the type those return
      // (`legacy-ts.ts`'s `factoryResultQualifiedNameOf`), so the key carries
      // the subpath specifier the source wrote.
      expect(
        lookupClientEffects("mysql2/promise.Pool.query", literal("SELECT id FROM audit")),
      ).toEqual(["db_read"]);
      expect(
        lookupClientEffects("mysql2/promise.Pool.execute", literal("INSERT INTO audit VALUES (?)")),
      ).toEqual(["db_write"]);
      expect(lookupClientEffects("mysql2/promise.Connection.query", literal("SELECT 1"))).toEqual([
        "db_read",
      ]);
      expect(
        lookupClientEffects("mysql2/promise.Connection.execute", literal("UPDATE audit SET x = 1")),
      ).toEqual(["db_write"]);
    });

    it("keeps both directions for a `mysql2/promise` statement the source does not fix", () => {
      expect(lookupClientEffects("mysql2/promise.Pool.execute", undefined)).toEqual([
        "db_read",
        "db_write",
      ]);
    });

    it("says nothing about a `mysql2/promise` method no row covers", () => {
      // The subpath is not a licence for the whole client surface.
      expect(lookupClientEffects("mysql2/promise.Pool.end", undefined)).toBeUndefined();
      expect(lookupClientEffects("mysql2/promise.Pool.getConnection", undefined)).toBeUndefined();
      expect(lookupClientEffects("mysql2/promise.PoolConnection.query", undefined)).toBeUndefined();
    });

    it("reads the keyword from a template literal's static head", () => {
      expect(
        lookupClientEffects("pg.Pool.query", templatePrefix("SELECT * FROM orders WHERE id = ")),
      ).toEqual(["db_read"]);
    });

    it("returns both directions when the statement is not statically readable", () => {
      // The recorded design decision (DESIGN.md §4.2): an operation whose
      // direction the source does not fix contributes both, not the safer-
      // sounding read.
      expect(lookupClientEffects("pg.Pool.query", undefined)).toEqual(["db_read", "db_write"]);
      expect(lookupClientEffects("pg.Pool.query", [undefined])).toEqual(["db_read", "db_write"]);
      expect(lookupClientEffects("pg.Pool.query", templatePrefix(""))).toEqual([
        "db_read",
        "db_write",
      ]);
    });

    it("returns both directions for a CTE, whose body may write", () => {
      expect(
        lookupClientEffects("pg.Pool.query", literal("WITH moved AS (DELETE FROM a RETURNING *)")),
      ).toEqual(["db_read", "db_write"]);
    });

    it("returns both directions for an object-form query it cannot read a statement from", () => {
      expect(
        lookupClientEffects("pg.Pool.query", [{ properties: new Map([["name", "byId"]]) }]),
      ).toEqual(["db_read", "db_write"]);
    });
  });

  describe("Prisma delegates", () => {
    it("matches any model name in the delegate position", () => {
      // The model segment comes from the user's schema, so it cannot be
      // enumerated — the pattern has to accept whatever is written.
      expect(lookupClientEffects("@prisma/client.PrismaClient.user.findMany", undefined)).toEqual([
        "db_read",
      ]);
      expect(
        lookupClientEffects("@prisma/client.PrismaClient.invoiceLine.findMany", undefined),
      ).toEqual(["db_read"]);
    });

    it("separates reading delegates from writing ones", () => {
      for (const method of [
        "findFirst",
        "findFirstOrThrow",
        "findUnique",
        "findUniqueOrThrow",
        "count",
        "aggregate",
        "groupBy",
      ]) {
        expect(
          lookupClientEffects(`@prisma/client.PrismaClient.order.${method}`, undefined),
        ).toEqual(["db_read"]);
      }
      for (const method of [
        "create",
        "createMany",
        "update",
        "updateMany",
        "upsert",
        "delete",
        "deleteMany",
      ]) {
        expect(
          lookupClientEffects(`@prisma/client.PrismaClient.order.${method}`, undefined),
        ).toEqual(["db_write"]);
      }
    });

    it("follows Prisma's own split for raw access, without reading the statement", () => {
      expect(lookupClientEffects("@prisma/client.PrismaClient.$queryRaw", undefined)).toEqual([
        "db_read",
      ]);
      expect(lookupClientEffects("@prisma/client.PrismaClient.$queryRawUnsafe", undefined)).toEqual(
        ["db_read"],
      );
      expect(lookupClientEffects("@prisma/client.PrismaClient.$executeRaw", undefined)).toEqual([
        "db_write",
      ]);
      expect(
        lookupClientEffects("@prisma/client.PrismaClient.$executeRawUnsafe", undefined),
      ).toEqual(["db_write"]);
    });

    it("treats a transaction as both, since its statements are the caller's", () => {
      expect(lookupClientEffects("@prisma/client.PrismaClient.$transaction", undefined)).toEqual([
        "db_read",
        "db_write",
      ]);
    });

    it("does not match a delegate method through the wrong number of segments", () => {
      expect(
        lookupClientEffects("@prisma/client.PrismaClient.findMany", undefined),
      ).toBeUndefined();
      expect(
        lookupClientEffects("@prisma/client.PrismaClient.a.b.findMany", undefined),
      ).toBeUndefined();
    });
  });

  describe("LLM SDKs", () => {
    it("recognizes both the named and the default export spelling", () => {
      expect(lookupClientEffects("openai.OpenAI.chat.completions.create", undefined)).toEqual([
        "llm",
      ]);
      expect(lookupClientEffects("openai.default.chat.completions.create", undefined)).toEqual([
        "llm",
      ]);
      expect(lookupClientEffects("openai.OpenAI.responses.create", undefined)).toEqual(["llm"]);
      expect(lookupClientEffects("openai.OpenAI.embeddings.create", undefined)).toEqual(["llm"]);
      expect(lookupClientEffects("@anthropic-ai/sdk.Anthropic.messages.create", undefined)).toEqual(
        ["llm"],
      );
      expect(lookupClientEffects("@anthropic-ai/sdk.default.messages.create", undefined)).toEqual([
        "llm",
      ]);
    });
  });
});
