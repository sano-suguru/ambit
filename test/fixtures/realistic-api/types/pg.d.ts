/**
 * Minimal `pg` surface. Only the module specifier and the exported class name
 * are what Ambit's stub table keys on, so a fixture-local declaration and a
 * real `npm install pg` produce the same qualified names — nothing has to be
 * installed for this fixture to mean something.
 */
declare module "pg" {
  export interface QueryResult<Row = unknown> {
    readonly rows: readonly Row[];
    readonly rowCount: number;
  }

  export interface PoolConfig {
    readonly connectionString?: string;
    readonly max?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<Row = unknown>(sql: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
    end(): Promise<void>;
  }
}
