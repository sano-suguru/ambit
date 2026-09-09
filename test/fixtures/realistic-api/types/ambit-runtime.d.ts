/**
 * The `ambit/runtime` surface this project uses. Declared locally for the same
 * reason as the other packages: the fixture must resolve with nothing
 * installed, and Ambit matches `withAmbit` by module specifier and export
 * name, which are the same either way.
 */
declare module "ambit/runtime" {
  export interface AmbitBudget {
    readonly timeMs?: number;
    readonly costUsd?: number;
    readonly llmCalls?: number;
    readonly onExceed?: "throw" | "warn" | "abort";
  }

  export interface AmbitSpec {
    readonly capabilities?: readonly string[];
    readonly budget?: AmbitBudget;
  }

  export function withAmbit<Args extends readonly unknown[], Result>(
    spec: AmbitSpec,
    handler: (...args: Args) => Result,
  ): (...args: Args) => Result;
}

declare module "ambit/runtime/hono" {
  import type { AmbitSpec } from "ambit/runtime";
  import type { Context } from "hono";

  export function ambitHandler<Args extends readonly unknown[], Result>(
    spec: AmbitSpec,
    handler: (...args: Args) => Result | Promise<Result>,
    decode: (c: Context) => readonly [...Args] | Promise<readonly [...Args]>,
  ): (c: Context) => Promise<Response>;
}
