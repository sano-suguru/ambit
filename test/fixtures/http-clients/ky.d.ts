/**
 * Minimal `ky` surface, declared locally so this fixture resolves with nothing
 * installed. A call is keyed on the module specifier and the export name, so a
 * `declare module "ky"` and an installed `ky` produce the same key — the same
 * property `src/stubs/data-clients.ts` relies on for the client tables.
 *
 * Shape read off `ky@1.14.3`: the default export is a callable whose request
 * methods take `(url, options)`, and `extend` returns another instance.
 */
declare module "ky" {
  export interface Options {
    readonly method?: string;
    readonly json?: unknown;
  }

  export interface KyInstance {
    <T>(url: string, options?: Options): Promise<T>;
    get<T>(url: string, options?: Options): Promise<T>;
    post<T>(url: string, options?: Options): Promise<T>;
    extend(options: Options): KyInstance;
  }

  const ky: KyInstance;
  export default ky;
}
