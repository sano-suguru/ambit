import { AsyncLocalStorage } from "node:async_hooks";
import type { Budget, Capability } from "../core/index.ts";

/**
 * The capability and budget context an entrypoint establishes (DESIGN.md
 * §4.4). `AsyncLocalStorage` holds the context; the blocking itself is the
 * hooks' job — §4.4 is explicit that the two are separate
 * (「`AsyncLocalStorage` はコンテキストの保持を担い、遮断そのものはアダプタが
 * 実装する」).
 *
 * Nothing here imports `typescript` or anything under `src/checker/`:
 * §3.4 keeps runtime enforcement independent of the analysis engine, so
 * production never depends on a compiler. `test/architecture.test.ts`
 * enforces that.
 */
export interface AmbitContext {
  readonly capabilities: readonly Capability[];
  readonly budget?: Budget;
  /** Wall-clock start, for `timeMs`. */
  readonly startedAt: number;
  /** Aborted when a `timeMs` budget with `onExceed: "abort"` runs out. */
  readonly signal?: AbortSignal;
  /** Every capability check made in this context, for auditing. */
  readonly audit: AuditEntry[];
}

export interface AuditEntry {
  readonly capability: string;
  readonly allowed: boolean;
  readonly reason: "granted" | "denied" | "unscoped";
}

/**
 * What a capability check does when no entrypoint context is active
 * (DESIGN.md §4.4 `runtime.unscoped`). `allow` is the default so that
 * adopting the runtime does not break code that has no entrypoints declared
 * yet (P3: 段階的導入).
 */
export type UnscopedPolicy = "allow" | "warn" | "deny";

const storage = new AsyncLocalStorage<AmbitContext>();

export function currentContext(): AmbitContext | undefined {
  return storage.getStore();
}

export function runInContext<T>(context: AmbitContext, fn: () => T): T {
  return storage.run(context, fn);
}
