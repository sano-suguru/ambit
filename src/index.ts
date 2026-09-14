/**
 * Package entry point. Re-exports the contract model and diagnostic types so a
 * consumer can type NDJSON output from `ambit check` without depending on the
 * checker or on `typescript`.
 *
 * Runtime enforcement is a separate entry (`ambit-ts/runtime`) so a production
 * process imports only what it needs: production uses `ambit-ts/runtime` and
 * the necessary adapters, and the compiler and the development CLI are not to
 * be required production dependencies.
 * The single package does not yet meet that: `typescript` is a `dependencies`
 * entry, so importing only the runtime still installs the compiler. ADR-0009
 * records the decision to keep one package until a production adopter exists.
 */
export * from "./core/index.ts";
