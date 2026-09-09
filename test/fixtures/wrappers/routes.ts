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
