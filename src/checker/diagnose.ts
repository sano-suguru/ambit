import type {
  ContractViaEntry,
  Diagnostic,
  DiagnosticEngine,
  KnownEffect,
  SymbolId,
} from "../core/index.ts";
import { excessEffects, KNOWN_EFFECTS } from "../core/index.ts";
import type { PropagatedFunction } from "./propagate.ts";
import { unknownWitnessChain, witnessChain } from "./propagate.ts";

/**
 * Compare declared vs. observed effects for every declared function and
 * produce diagnostics (DESIGN.md §5.1). Undeclared functions
 * (`declared.kind === "none"`) are not diagnosed here — see the plan's note
 * on §4.2/§4.3: undeclared is a coverage concern, not a propagation input.
 *
 * `engine` identifies the backend that produced `state` (DESIGN.md §3.4) and
 * is attached to every diagnostic emitted.
 */
export function diagnose(
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const propagated of state.values()) {
    const { summary } = propagated;

    if (summary.declared.kind === "invalid") {
      diagnostics.push(buildInvalidEffectsDiagnostic(propagated, summary.declared.raw, engine));
      continue;
    }
    if (summary.declared.kind !== "declared") continue;

    const declaredEffects = summary.declared.effects;
    const excess = excessEffects(declaredEffects, propagated.observed);

    if (excess.size > 0) {
      diagnostics.push(
        buildExcessDiagnostic(propagated, declaredEffects.effects, excess, state, engine),
      );
    }

    if (propagated.observed.unknown) {
      diagnostics.push(buildUnknownDiagnostic(propagated, declaredEffects.effects, state, engine));
    }
  }

  return diagnostics;
}

function buildExcessDiagnostic(
  propagated: PropagatedFunction,
  declared: ReadonlySet<KnownEffect>,
  excess: ReadonlySet<KnownEffect>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;

  // Deterministic choice of which excess effect's path to show in `via`:
  // KNOWN_EFFECTS declaration order, not Set iteration/insertion order.
  const primaryEffect = KNOWN_EFFECTS.find((effect) => excess.has(effect));
  const chain = primaryEffect ? witnessChain(summary.id, primaryEffect, state) : [];
  const via = chainToVia(chain, state);

  const fnName = displayName(summary.id);
  const excessList = [...excess].filter((e) => KNOWN_EFFECTS.includes(e));
  const declaredList = declaredContractList(declared).join(", ");

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
      declared: declaredContractList(declared),
      observed: [...propagated.observed.effects],
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e001",
    engine,
  };
}

function buildUnknownDiagnostic(
  propagated: PropagatedFunction,
  declared: ReadonlySet<KnownEffect>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  const chain = unknownWitnessChain(summary.id, state);
  const via = chainToVia(chain, state);
  const fnName = displayName(summary.id);
  const declaredList = declaredContractList(declared).join(", ");

  const message =
    via.length > 0
      ? `${fnName} declares ${declaredList} but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which could not be resolved`
      : `${fnName} declares ${declaredList} but calls something that could not be resolved`;

  return {
    id: "AMB-W001",
    severity: "warning",
    category: "effects",
    message,
    location: summary.location,
    contract: {
      declared: declaredContractList(declared),
      observed: [...propagated.observed.effects],
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-w001",
    engine,
  };
}

/**
 * A `@effects` tag that failed to parse (`summarize.ts`'s `parseEffectsTag`
 * returned `undefined` — a token that is neither `pure` nor a known effect).
 * Reported instead of the excess/unknown diagnostics above, never alongside
 * them: `summarizeExtractedFiles` already treats this function as
 * undeclared for propagation, so it cannot also carry an observed-vs-declared
 * mismatch.
 */
function buildInvalidEffectsDiagnostic(
  propagated: PropagatedFunction,
  raw: string,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  const fnName = displayName(summary.id);

  return {
    id: "AMB-E002",
    severity: "error",
    category: "effects",
    message: `${fnName} declares @effects "${raw}", which is not "pure" or a known effect name`,
    location: summary.location,
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e002",
    engine,
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

/** `["pure"]` for the declared empty set, matching DESIGN.md §5.1's example; the known effects otherwise. */
function declaredContractList(
  declared: ReadonlySet<KnownEffect>,
): readonly (KnownEffect | "pure")[] {
  return declared.size === 0 ? ["pure"] : [...declared];
}

function displayName(id: SymbolId): string {
  const afterHash = id.split("#")[1] ?? id;
  const parts = afterHash.split(".");
  return parts[parts.length - 1] ?? id;
}
