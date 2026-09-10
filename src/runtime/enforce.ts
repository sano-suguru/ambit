import type { Capability } from "../core/index.ts";
import { capabilityCovers, formatCapability, parseCapability } from "../core/index.ts";
import type { AuditEntry, UnscopedPolicy } from "./context.ts";
import { currentContext } from "./context.ts";

/**
 * The capability decision every hook shares (DESIGN.md §4.4).
 *
 * Separate from `index.ts` so that `fs.ts`, `child-process.ts` and `pg.ts` can
 * import the decision without importing the module that installs them, and so
 * that the `runtime.unscoped` policy is one variable rather than one per hook.
 */
export class AmbitCapabilityError extends Error {
  readonly capability: string;
  constructor(capability: string, granted: readonly Capability[], detail?: string) {
    const grantedList = granted.map(formatCapability).join(", ") || "(none)";
    const suffix = detail ? ` — ${detail}` : "";
    super(
      `capability ${capability} is not granted by this entrypoint (granted: ${grantedList})${suffix}`,
    );
    this.name = "AmbitCapabilityError";
    this.capability = capability;
  }
}

let unscopedPolicy: UnscopedPolicy = "allow";

/**
 * Set the process-wide `runtime.unscoped` policy (DESIGN.md §4.4).
 *
 * Process-wide and not per-entrypoint on purpose. The policy only applies
 * where there is *no* context, so a per-entrypoint override would be read
 * only by concurrent work running outside every entrypoint — which makes it a
 * mutable global that unrelated calls observe changing mid-flight, not a
 * setting scoped to anything. Set it once at startup.
 */
export function setUnscopedPolicy(policy: UnscopedPolicy): void {
  unscopedPolicy = policy;
}

/**
 * Decide one capability without throwing, so a callback-style API can deliver
 * the denial the way its caller expects (DESIGN.md §4.4: "synchronous APIs
 * `throw`, callback APIs use `process.nextTick(callback, error)`, and Promise
 * APIs reject").
 *
 * Returns the error to deliver, or `undefined` when the operation is allowed.
 * Every decision inside a context — allowed or denied — is appended to the
 * context's {@link AuditEntry} list.
 */
export function checkCapability(
  required: string,
  detail?: string,
): AmbitCapabilityError | undefined {
  const context = currentContext();
  if (!context) {
    if (unscopedPolicy === "deny") {
      return new AmbitCapabilityError(required, [], detail ?? "no @entrypoint context is active");
    }
    if (unscopedPolicy === "warn") {
      process.emitWarning(
        `capability ${required} used outside any @entrypoint context`,
        "AmbitUnscoped",
      );
    }
    return undefined;
  }

  const parsed = parseCapability(required);
  const allowed =
    parsed !== undefined && context.capabilities.some((grant) => capabilityCovers(grant, parsed));
  const entry: AuditEntry = {
    capability: required,
    allowed,
    reason: allowed ? "granted" : "denied",
  };
  context.audit.push(entry);
  if (allowed) return undefined;
  return new AmbitCapabilityError(required, context.capabilities, detail);
}

/**
 * Decide several capabilities at once, all of which are required. Used where
 * one operation touches two resources (`fs.rename`) or where the source does
 * not fix the direction, so both directions are required (an opaque SQL
 * statement — DESIGN.md §4.4 (c)).
 *
 * Every capability is checked, so the audit records all of them, and the
 * first denial is the one reported.
 */
export function checkCapabilities(
  required: readonly string[],
  detail?: string,
): AmbitCapabilityError | undefined {
  let first: AmbitCapabilityError | undefined;
  for (const capability of required) {
    const error = checkCapability(capability, detail);
    if (error && !first) first = error;
  }
  return first;
}

/**
 * Check one capability against the active entrypoint context, throwing
 * {@link AmbitCapabilityError} when it is not granted. Exported so an adapter
 * for an unhooked client can perform the same check.
 *
 * With no active context the `runtime.unscoped` policy decides (§4.4).
 */
export function requireCapability(required: string, detail?: string): void {
  const error = checkCapability(required, detail);
  if (error) throw error;
}
