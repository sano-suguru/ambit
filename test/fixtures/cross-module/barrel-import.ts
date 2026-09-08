import { fetchRate } from "./index.ts";

/** @effects pure */
export function pureCallsBarrelImportedNetwork(): number {
  return fetchRate();
}
