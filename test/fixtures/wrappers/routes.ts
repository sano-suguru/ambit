import { withAmbit } from "ambit/runtime";
import { ambitHandler } from "ambit/runtime/hono";

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function agreeing(id: string): string {
  return id;
}

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function drifting(id: string): string {
  return id;
}

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function driftingByAdapter(id: string): string {
  return id;
}

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function dynamicByAdapter(id: string): string {
  return id;
}

// Agrees with the JSDoc: no diagnostic.
export const AGREEING = ambitHandler({ capabilities: ["db:read:orders"] }, agreeing, () => [""]);

// The hand-written form still drifts, and is still caught (AMB-E010).
export const DRIFTING = withAmbit({ capabilities: ["db:write:orders"] }, drifting);

// The adapter's registration drifts the same way, and is caught the same way.
export const DRIFTING_BY_ADAPTER = ambitHandler(
  { capabilities: ["db:write:orders"] },
  driftingByAdapter,
  () => [""],
);

const built = ["db:read:orders"];

// Not a literal array: not compared, reported as AMB-W004.
export const DYNAMIC_BY_ADAPTER = ambitHandler({ capabilities: built }, dynamicByAdapter, () => [
  "",
]);

// --- §4.4's agreement check on `@budget` ---------------------------------

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @budget timeMs=500 onExceed=throw
 * @effects pure
 */
export function agreeingBudget(id: string): string {
  return id;
}

// The spec omits `onExceed`; both sides default it to `throw`, so they agree.
export const AGREEING_BUDGET = ambitHandler(
  { capabilities: ["db:read:orders"], budget: { timeMs: 500 } },
  agreeingBudget,
  () => [""],
);

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @budget timeMs=800 onExceed=throw
 * @effects pure
 */
export function driftingTimeMs(id: string): string {
  return id;
}

// A widened `timeMs`: the limit the runtime applies is not the declared one.
export const DRIFTING_TIME_MS = ambitHandler(
  { capabilities: ["db:read:orders"], budget: { timeMs: 5000, onExceed: "throw" } },
  driftingTimeMs,
  () => [""],
);

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @budget timeMs=500 onExceed=warn
 * @effects pure
 */
export function driftingOnExceed(id: string): string {
  return id;
}

// Same limit, different policy on exceeding it.
export const DRIFTING_ON_EXCEED = withAmbit(
  { capabilities: ["db:read:orders"], budget: { timeMs: 500, onExceed: "abort" } },
  driftingOnExceed,
);

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @budget timeMs=500 costUsd=0.01 onExceed=throw
 * @effects pure
 */
export function jsDocOnlyCostUsd(id: string): string {
  return id;
}

// A limit on one side only: the JSDoc declares a `costUsd` the spec does not.
export const JSDOC_ONLY_COST_USD = ambitHandler(
  { capabilities: ["db:read:orders"], budget: { timeMs: 500, onExceed: "throw" } },
  jsDocOnlyCostUsd,
  () => [""],
);

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @budget timeMs=500
 * @effects pure
 */
export function dynamicBudget(id: string): string {
  return id;
}

const builtBudget = { timeMs: 500, onExceed: "throw" } as const;

// Not an object literal: not compared, reported as AMB-W004.
export const DYNAMIC_BUDGET = ambitHandler(
  { capabilities: ["db:read:orders"], budget: builtBudget },
  dynamicBudget,
  () => [""],
);

// --- The spec as the declaration (DESIGN.md §4.4) -------------------------

/**
 * @entrypoint
 * @effects pure
 */
export function specOnly(id: string): string {
  return id;
}

// No `@capabilities` and no `@budget` beside the handler: the literal spec is
// the declaration. Nothing to disagree with, so no AMB-E010/E011, and the
// entrypoint is not capability-less, so no AMB-W002 either.
export const SPEC_ONLY = ambitHandler(
  { capabilities: ["db:read:orders"], budget: { timeMs: 500, onExceed: "throw" } },
  specOnly,
  () => [""],
);

/**
 * @entrypoint
 * @capabilities db:read:orders
 * @effects pure
 */
export function specOnlyBudget(id: string): string {
  return id;
}

// Halves are independent: the JSDoc declares the capability set, the spec
// declares the budget, and neither repeats the other.
export const SPEC_ONLY_BUDGET = withAmbit(
  { capabilities: ["db:read:orders"], budget: { timeMs: 500 } },
  specOnlyBudget,
);

/**
 * @entrypoint
 * @effects pure
 */
export function specNotLiteral(id: string): string {
  return id;
}

// The spec is built at runtime, so it declares nothing readable. Dropping the
// JSDoc here does not make the contract implicit — it makes it missing, and
// that stays visible as AMB-W004 plus AMB-W002.
export const SPEC_NOT_LITERAL = ambitHandler({ capabilities: built }, specNotLiteral, () => [""]);
