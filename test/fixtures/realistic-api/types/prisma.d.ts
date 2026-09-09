/** Minimal `@prisma/client` surface — see `pg.d.ts` for why it is declared here. */
declare module "@prisma/client" {
  export interface UserRecord {
    readonly id: string;
    readonly email: string;
    readonly name: string;
  }

  export interface UserDelegate {
    findMany(args?: unknown): Promise<readonly UserRecord[]>;
    findUnique(args: unknown): Promise<UserRecord | null>;
    create(args: unknown): Promise<UserRecord>;
    update(args: unknown): Promise<UserRecord>;
    delete(args: unknown): Promise<UserRecord>;
  }

  export class PrismaClient {
    readonly user: UserDelegate;
    $queryRaw(query: string, ...values: readonly unknown[]): Promise<readonly unknown[]>;
    $executeRaw(query: string, ...values: readonly unknown[]): Promise<number>;
    $disconnect(): Promise<void>;
  }
}
