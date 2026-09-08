import type { ContractViaEntry, Diagnostic, KnownEffect, SymbolId } from "../core/index.ts";
import { excessEffects, KNOWN_EFFECTS } from "../core/index.ts";
import type { PropagatedFunction } from "./propagate.ts";
import { unknownWitnessChain, witnessChain } from "./propagate.ts";

/**
 * Compare declared vs. observed effects for every declared function and
 * produce diagnostics (DESIGN.md §5.1). Undeclared functions
 * (`declared.kind === "none"`) are not diagnosed here — see the plan's note
 * on §4.2/§4.3: undeclared is a coverage concern, not a propagation input.
 */
export function diagnose(state: ReadonlyMap<SymbolId, PropagatedFunction>): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const propagated of state.values()) {
    const { summary } = propagated;
    if (summary.declared.kind !== "declared") continue;

    const declaredEffects = summary.declared.effects;
    const excess = excessEffects(declaredEffects, propagated.observed);

    if (excess.size > 0) {
      diagnostics.push(buildExcessDiagnostic(propagated, declaredEffects.effects, excess, state));
    }

    const isDeclaredPure = declaredEffects.effects.size === 0 && !declaredEffects.unknown;
    if (isDeclaredPure && propagated.observed.unknown) {
      diagnostics.push(buildUnknownDiagnostic(propagated, state));
    }
  }

  return diagnostics;
}

function buildExcessDiagnostic(
  propagated: PropagatedFunction,
  declared: ReadonlySet<KnownEffect>,
  excess: ReadonlySet<KnownEffect>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): Diagnostic {
  const { summary } = propagated;

  // Deterministic choice of which excess effect's path to show in `via`:
  // KNOWN_EFFECTS declaration order, not Set iteration/insertion order.
  const primaryEffect = KNOWN_EFFECTS.find((effect) => excess.has(effect));
  const chain = primaryEffect ? witnessChain(summary.id, primaryEffect, state) : [];
  const via = chainToVia(chain, state);

  const fnName = displayName(summary.id);
  const excessList = [...excess].filter((e) => KNOWN_EFFECTS.includes(e));
  const declaredList = declared.size === 0 ? "pure" : [...declared].join(", ");

  const message =
    via.length > 0
      ? `${fnName} declares ${declaredList} but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which has effects [${excessList.join(", ")}]`
      : `${fnName} declares ${declaredList} but performs [${excessList.join(", ")}] directly`;

  return {
    id: "AMB-E001",
    severity: "error",
    category: "effects",
    message,
    location: summary.location,
    contract: {
      declared: [...declared],
      observed: [...propagated.observed.effects],
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e001",
  };
}

function buildUnknownDiagnostic(
  propagated: PropagatedFunction,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): Diagnostic {
  const { summary } = propagated;
  const chain = unknownWitnessChain(summary.id, state);
  const via = chainToVia(chain, state);
  const fnName = displayName(summary.id);

  const message =
    via.length > 0
      ? `${fnName} declares pure but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which could not be resolved`
      : `${fnName} declares pure but calls something that could not be resolved`;

  return {
    id: "AMB-W001",
    severity: "warning",
    category: "effects",
    message,
    location: summary.location,
    contract: {
      declared: [],
      observed: [...propagated.observed.effects],
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-w001",
  };
}

function chainToVia(
  chain: readonly SymbolId[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly ContractViaEntry[] {
  return chain.map((id) => {
    const location = state.get(id)?.summary.location;
    return { symbol: id, file: location?.file ?? "", line: location?.line ?? 0 };
  });
}

function displayName(id: SymbolId): string {
  const afterHash = id.split("#")[1] ?? id;
  const parts = afterHash.split(".");
  return parts[parts.length - 1] ?? id;
}
