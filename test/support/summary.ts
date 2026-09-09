import type {
  DeclaredBoundary,
  DeclaredBudget,
  DeclaredCapabilities,
  Diagnostic,
  KnownEffect,
  SourceLocation,
} from "../../src/core/index.ts";
import { isEffectsContract } from "../../src/core/index.ts";

/**
 * The contract fields a hand-built `FunctionSummary` leaves undeclared.
 * Spread this rather than omitting them: every contract field on
 * `FunctionSummary` is required so that adding one cannot silently drop it
 * from a backend or a summarizer, and a test opting out of one should say so.
 */
export const NO_OTHER_CONTRACTS: {
  readonly tagLocations: ReadonlyMap<string, SourceLocation>;
  readonly declarationStart: SourceLocation;
  readonly capabilities: DeclaredCapabilities;
  readonly budget: DeclaredBudget;
  readonly boundary: DeclaredBoundary;
  readonly entrypoint: false;
} = {
  tagLocations: new Map(),
  declarationStart: { file: "f.ts", line: 1, col: 1, endLine: 1, endCol: 1 },
  capabilities: { kind: "none" },
  budget: { kind: "none" },
  boundary: { kind: "none" },
  entrypoint: false,
};

/**
 * A diagnostic's observed effect list, or `undefined` when it carries no
 * contract or carries a capabilities contract instead. `Diagnostic.contract`
 * is a union with no discriminant field (see `isEffectsContract`), so a test
 * asserting on effects has to narrow it.
 */
export function observedEffects(
  diagnostic: Diagnostic | undefined,
): readonly (KnownEffect | "pure")[] | undefined {
  const contract = diagnostic?.contract;
  if (!contract || !isEffectsContract(contract)) return undefined;
  return contract.observed;
}
