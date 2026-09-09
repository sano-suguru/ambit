/**
 * The shape of `ambit.config.ts` (DESIGN.md §4.1「コード外宣言」).
 *
 * Types only — no loader, no filesystem, no compiler. This module is what
 * `ambit/config` exports, so a consumer's config file gets the same type
 * checking a JSDoc contract gets from the checker, without pulling the
 * checker (or `typescript`) into their project's type graph.
 */
import type { BudgetInput } from "./budget.ts";

/**
 * One symbol's contract, written where the code cannot be touched.
 *
 * The five keys are the five JSDoc contract tags (§4.1), and they mean the
 * same thing here as there — a config declaration is not a weaker kind of
 * declaration, it is the same declaration written somewhere else.
 *
 * `effects` accepts a user-defined name from {@link AmbitConfig.effects}
 * alongside the standard ones; the loader expands it before anything else
 * sees it (§4.1 (d)).
 */
export interface ConfigContract {
  readonly effects?: readonly string[];
  readonly capabilities?: readonly string[];
  /** The `@budget` tag's fields, as an object rather than as tag text. */
  readonly budget?: BudgetInput;
  readonly entrypoint?: boolean;
  /** `@boundary reason="…"`'s reason. §4.6 makes it mandatory, so there is no bare `true`. */
  readonly boundary?: string;
}

export interface AmbitConfig {
  /**
   * User-defined effect names, each a combination of standard effects
   * (DESIGN.md §4.2: 「ユーザー定義エフェクトは `ambit.config.ts` で標準
   * エフェクトの組み合わせとして宣言できる」). Usable from both `@effects`
   * and {@link ConfigContract.effects}. Values are standard effect names
   * only: a definition never expands into another definition.
   */
  readonly effects?: Readonly<Record<string, readonly string[]>>;
  /**
   * Contracts keyed by `"<file>#<symbol>"`. `<file>` is relative to this
   * config file's directory and may use `*` and `**`; `<symbol>` is the
   * declaration path and may not (§4.1 (a), (b)).
   */
  readonly contracts?: Readonly<Record<string, ConfigContract>>;
}

/**
 * Identity. It exists for the type checking and completion a consumer gets
 * from writing `defineConfig({ … })`, and for nothing else — so a config that
 * exports a bare object literal is exactly as valid, which is what the
 * in-repo fixtures rely on (they cannot resolve `ambit/config` from a scratch
 * directory).
 */
export function defineConfig(config: AmbitConfig): AmbitConfig {
  return config;
}
