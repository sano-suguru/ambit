/** The `pg` surface this project uses, declared locally (see `next.d.ts`). */
declare module "pg" {
  export interface QueryResult<Row> {
    readonly rows: readonly Row[];
  }

  export class Pool {
    constructor(config?: { readonly connectionString?: string });
    query<Row>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
  }
}
