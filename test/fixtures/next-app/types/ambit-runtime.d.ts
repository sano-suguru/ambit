/**
 * The `ambit-ts/runtime` and `ambit-ts/runtime/next` surfaces this project uses,
 * declared locally so the fixture type-checks with nothing installed.
 */
declare module "ambit-ts/runtime" {
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
}

declare module "ambit-ts/runtime/next" {
  import type { AmbitSpec } from "ambit-ts/runtime";
  import type { NextRequest } from "next/server";

  export interface RouteContext<Params extends Record<string, string | readonly string[]>> {
    readonly params: Promise<Params>;
  }

  export function ambitRoute<
    Args extends readonly unknown[],
    Result,
    Params extends Record<string, string | readonly string[]> = Record<string, string>,
  >(
    spec: AmbitSpec,
    handler: (...args: Args) => Result | Promise<Result>,
    decode: (
      request: NextRequest,
      context: RouteContext<Params>,
    ) => readonly [...Args] | Promise<readonly [...Args]>,
  ): (request: NextRequest, context: RouteContext<Params>) => Promise<Response>;
}
