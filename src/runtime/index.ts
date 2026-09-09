import type { Budget } from "../core/index.ts";
import { parseCapability } from "../core/index.ts";
import type { AmbitContext } from "./context.ts";
import { currentContext, runInContext } from "./context.ts";
import { requireCapability } from "./enforce.ts";

export { installChildProcessHook, spawnCapability } from "./child-process.ts";
export type { AmbitContext, AuditEntry, UnscopedPolicy } from "./context.ts";
export { currentContext } from "./context.ts";
export {
  AmbitCapabilityError,
  checkCapabilities,
  checkCapability,
  requireCapability,
  setUnscopedPolicy,
} from "./enforce.ts";
export { fsCapabilities, installFsHook } from "./fs.ts";
export { installPgHook, pgCapabilities } from "./pg.ts";

/**
 * Runtime enforcement for an entrypoint (DESIGN.md §4.4, §4.5).
 *
 * Deliberately narrow, and the narrowness is the point: this enforces what it
 * can actually check and says nothing about the rest. What is enforced today:
 *
 * - **capabilities**, for `globalThis.fetch` ({@link installFetchHook}),
 *   `node:fs` and `node:fs/promises` ({@link installFsHook}),
 *   `node:child_process` ({@link installChildProcessHook}), and the `pg`
 *   client ({@link installPgHook}) — each once its hook has been installed.
 *   Every other operation is unhooked and therefore unenforced: `mysql2`,
 *   `@prisma/client`, `drizzle-orm`, `mongodb`, and every LLM SDK.
 * - **`timeMs`**, checked when the handler settles (`throw`/`warn`) or via an
 *   `AbortSignal` (`abort`).
 *
 * What is **not** enforced: `costUsd` and `llmCalls`. There is no LLM hook, so
 * nothing would increment those counters; reporting them as enforced would be
 * a number nobody measures. They are carried on the context for an adapter to
 * use and are otherwise inert.
 */
export interface AmbitSpec {
  /** The entrypoint's `@capabilities`, as written (`db:read:users`). */
  readonly capabilities?: readonly string[];
  readonly budget?: Budget;
}

export class AmbitBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbitBudgetError";
  }
}

/**
 * Run `handler` with the entrypoint's capability set and budget established
 * (DESIGN.md §4.4: 「アダプタがない場合は `withAmbit(spec, handler)` を手動で
 * 挟む」).
 *
 * A malformed capability string throws at wrap time rather than being
 * dropped: a grant that does not parse would silently become "grants nothing",
 * and the handler would fail in a way that looks like a policy decision.
 */
export function withAmbit<Args extends readonly unknown[], Result>(
  spec: AmbitSpec,
  handler: (...args: Args) => Result | Promise<Result>,
): (...args: Args) => Promise<Result> {
  const capabilities = (spec.capabilities ?? []).map((text) => {
    const capability = parseCapability(text);
    if (!capability) {
      throw new TypeError(`withAmbit: "${text}" is not a <resource>:<action>:<target> capability`);
    }
    return capability;
  });

  return async (...args: Args): Promise<Result> => {
    const controller = new AbortController();
    const context: AmbitContext = {
      capabilities,
      ...(spec.budget ? { budget: spec.budget } : {}),
      startedAt: Date.now(),
      signal: controller.signal,
      audit: [],
    };

    const timeMs = spec.budget?.timeMs;
    const onExceed = spec.budget?.onExceed ?? "throw";
    let timer: NodeJS.Timeout | undefined;
    if (timeMs !== undefined && onExceed === "abort") {
      timer = setTimeout(() => controller.abort(new AmbitBudgetError(exceeded(timeMs))), timeMs);
      timer.unref?.();
    }

    try {
      const result = await runInContext(context, () => handler(...args));
      const elapsed = Date.now() - context.startedAt;
      if (timeMs !== undefined && elapsed > timeMs) {
        // Checked after the fact, and that is all this can honestly be:
        // §4.5 says a budget does not undo spend already incurred or stop
        // work that cannot be cancelled.
        if (onExceed === "throw") throw new AmbitBudgetError(exceeded(timeMs, elapsed));
        if (onExceed === "warn") process.emitWarning(exceeded(timeMs, elapsed), "AmbitBudget");
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function exceeded(timeMs: number, elapsed?: number): string {
  const actual = elapsed === undefined ? "" : ` (took ${elapsed}ms)`;
  return `budget timeMs=${timeMs} exceeded${actual}`;
}

/**
 * Wrap `globalThis.fetch` so every request is checked against the active
 * entrypoint's capabilities as `http:<method>:<host>`.
 *
 * One of four hooks; see {@link installFsHook},
 * {@link installChildProcessHook} and {@link installPgHook} for the rest.
 * DESIGN.md §4.4's remaining targets — `mysql2`, `@prisma/client`,
 * `drizzle-orm`, `mongodb`, and the LLM SDKs — are not hooked, and calling
 * them is neither checked nor recorded.
 *
 * Returns a function that restores the original `fetch`, so a test — or a
 * consumer backing Ambit out (P5) — can undo it.
 */
export function installFetchHook(): () => void {
  const original = globalThis.fetch;
  if (typeof original !== "function") {
    throw new TypeError("installFetchHook: globalThis.fetch is not available");
  }

  const hooked: typeof globalThis.fetch = async (input, init) => {
    requireCapability(fetchCapability(input, init));
    // `onExceed: "abort"` aborts the entrypoint's signal; without joining it
    // to the request, the signal would fire and the request would keep going,
    // making the "abort" row of the README table false.
    const budgetSignal = currentContext()?.signal;
    if (!budgetSignal) return original(input, init);
    const signal = init?.signal ? AbortSignal.any([budgetSignal, init.signal]) : budgetSignal;
    return original(input, { ...init, signal });
  };
  globalThis.fetch = hooked;
  return () => {
    // Only restore if nothing else re-wrapped fetch in the meantime;
    // clobbering someone else's hook would be worse than leaving ours on.
    if (globalThis.fetch === hooked) globalThis.fetch = original;
  };
}

/**
 * `http:<method>:<host>` for a request. The host includes the port when the
 * URL carries one (`127.0.0.1:8080`), which is why a capability's target
 * segment is allowed to contain a colon.
 */
export function fetchCapability(input: Parameters<typeof fetch>[0], init?: RequestInit): string {
  const url =
    input instanceof URL
      ? input
      : new URL(typeof input === "string" ? input : (input as Request).url);
  const method = (
    init?.method ??
    (typeof input === "object" && "method" in input ? (input as Request).method : undefined) ??
    "GET"
  ).toLowerCase();
  return `http:${method}:${url.host}`;
}
