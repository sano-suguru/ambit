/**
 * The `next/server` surface this project uses, declared locally for the same
 * reason as the other packages in `test/fixtures/`: the fixture must resolve
 * with nothing installed, and Ambit matches `ambitRoute` by module specifier
 * and export name, which are the same either way.
 *
 * `NextRequest` is a `Request` with Next.js's additions; only the members the
 * routes here touch are declared.
 */
declare module "next/server" {
  export interface NextURL {
    readonly searchParams: URLSearchParams;
  }

  export interface NextRequest {
    readonly nextUrl: NextURL;
    json<T>(): Promise<T>;
  }
}
