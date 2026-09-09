/**
 * The two context-establishing entry points, declared locally so the fixture
 * resolves with nothing installed. Ambit matches both by module specifier and
 * export name (`src/checker/backend/legacy-ts.ts`), which is the same whether
 * the package is installed or declared here.
 */
declare module "ambit/runtime" {
  export interface AmbitSpec {
    readonly capabilities?: readonly string[];
    readonly budget?: { readonly timeMs?: number };
  }

  export function withAmbit<Args extends readonly unknown[], Result>(
    spec: AmbitSpec,
    handler: (...args: Args) => Result,
  ): (...args: Args) => Result;
}

declare module "ambit/runtime/hono" {
  import type { AmbitSpec } from "ambit/runtime";

  export function ambitHandler<Args extends readonly unknown[], Result>(
    spec: AmbitSpec,
    handler: (...args: Args) => Result | Promise<Result>,
    decode: (c: unknown) => readonly [...Args] | Promise<readonly [...Args]>,
  ): (c: unknown) => Promise<unknown>;
}

declare module "ambit/runtime/next" {
  import type { AmbitSpec } from "ambit/runtime";

  export function ambitRoute<Args extends readonly unknown[], Result>(
    spec: AmbitSpec,
    handler: (...args: Args) => Result | Promise<Result>,
    decode: (
      request: unknown,
      context: unknown,
    ) => readonly [...Args] | Promise<readonly [...Args]>,
  ): (request: unknown, context: unknown) => Promise<unknown>;
}
