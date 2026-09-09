/**
 * The `hono` surface this project uses, declared locally for the same reason
 * as the other packages: the fixture must resolve with nothing installed, and
 * Ambit matches `ambitHandler` by module specifier and export name, which are
 * the same either way.
 */
declare module "hono" {
  export interface HonoRequest {
    json<T>(): Promise<T>;
    param(name: string): string | undefined;
    query(name: string): string | undefined;
  }

  export interface Context {
    readonly req: HonoRequest;
  }
}
