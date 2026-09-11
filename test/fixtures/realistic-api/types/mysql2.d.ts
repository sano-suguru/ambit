/**
 * Minimal `mysql2/promise` surface — see `pg.d.ts` for why it is declared here.
 *
 * The real package builds a pool through the `createPool` factory, and the
 * fixture uses it that way on purpose: it is the shape a coding agent writes.
 * The names here match `mysql2@3.15.3/promise.d.ts` — `createPool(config):
 * Pool` — because the stub table is keyed on the type the factory returns.
 */
declare module "mysql2/promise" {
  export interface RowDataPacket {
    readonly [column: string]: unknown;
  }

  export interface PoolOptions {
    readonly uri?: string;
    readonly connectionLimit?: number;
  }

  export class Pool {
    query<Row = RowDataPacket>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<readonly [readonly Row[], unknown]>;
    execute<Row = RowDataPacket>(
      sql: string,
      values?: readonly unknown[],
    ): Promise<readonly [readonly Row[], unknown]>;
    end(): Promise<void>;
  }

  export function createPool(options: PoolOptions): Pool;
}
