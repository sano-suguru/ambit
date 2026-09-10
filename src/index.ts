/**
 * Package entry point. Re-exports the contract model and diagnostic types so a
 * consumer can type NDJSON output from `ambit check` without depending on the
 * checker or on `typescript`.
 *
 * Runtime enforcement is a separate entry (`ambit/runtime`) so a production
 * process imports only what it needs (DESIGN.md §6: "Production uses
 * `@ambit/runtime` and the necessary adapters and contract data. The compiler
 * and the development CLI are not made required production dependencies").
 */
export * from "./core/index.ts";
