import { fetchRate } from "./callee.ts";

/** @effects pure */
export function pureCallsImportedNetwork(): number {
  return fetchRate();
}
