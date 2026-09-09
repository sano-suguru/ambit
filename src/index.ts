/**
 * Package entry point. Re-exports the contract model and diagnostic types so a
 * consumer can type NDJSON output from `ambit check` without depending on the
 * checker or on `typescript`.
 *
 * Runtime enforcement is a separate entry (`ambit/runtime`) so a production
 * process imports only what it needs (DESIGN.md §6: 「本番では
 * `@ambit/runtime` と必要なアダプタ・契約データを利用する。コンパイラや開発用
 * CLI を本番の必須依存にしない」).
 */
export * from "./core/index.ts";
