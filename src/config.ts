/**
 * `ambit/config` — the entry point a consumer's `ambit.config.ts` imports
 * (DESIGN.md §4.1「コード外宣言」).
 *
 * Deliberately separate from `ambit` (the diagnostic types) and from
 * `ambit/runtime`: a config file is loaded by the CLI at check time, and
 * importing it must not drag the contract model, the runtime, or the checker
 * into the consumer's build.
 */

export type { BudgetInput, OnExceed } from "./core/budget.ts";
export type { AmbitConfig, ConfigContract } from "./core/config.ts";
export { defineConfig } from "./core/config.ts";
