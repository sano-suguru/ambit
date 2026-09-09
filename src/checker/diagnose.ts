import type {
  Capability,
  ContractViaEntry,
  Diagnostic,
  DiagnosticEngine,
  KnownEffect,
  SkippedFunctionKind,
  SymbolId,
  UncarriedContract,
} from "../core/index.ts";
import {
  excessCapabilities,
  excessEffects,
  formatCapability,
  KNOWN_EFFECTS,
} from "../core/index.ts";
import type { PropagatedFunction } from "./propagate.ts";
import {
  capabilityUnknownWitnessChain,
  capabilityWitnessChain,
  unknownWitnessChain,
  witnessChain,
} from "./propagate.ts";

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
    diagnostics.push(...diagnoseEffects(propagated, state, engine));
    diagnostics.push(...diagnoseCapabilities(propagated, state, engine));
    diagnostics.push(...diagnoseBoundary(propagated, engine));
    diagnostics.push(...diagnoseBudget(propagated, engine));
    diagnostics.push(...diagnoseEntrypoint(propagated, engine));
  }

  return diagnostics;
}

function diagnoseEffects(
  propagated: PropagatedFunction,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.declared.kind === "invalid") {
    return [buildInvalidEffectsDiagnostic(propagated, summary.declared.raw, engine)];
  }
  if (summary.declared.kind !== "declared") return [];

  const diagnostics: Diagnostic[] = [];
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
  return diagnostics;
}

/**
 * DESIGN.md §4.4's 縮小則: a callee may not require a capability its caller
 * does not grant. A function's own declaration is the grant; what its body
 * reaches is the requirement.
 */
function diagnoseCapabilities(
  propagated: PropagatedFunction,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.capabilities.kind === "invalid") {
    return [
      {
        id: "AMB-E004",
        severity: "error",
        category: "capabilities",
        message: `${displayName(summary.id)} declares @capabilities "${summary.capabilities.raw}", which is not a comma-separated list of <resource>:<action>:<target>`,
        location: summary.location,
        fixes: [],
        docs: "docs/diagnostics/README.md#amb-e004",
        engine,
      },
    ];
  }
  if (summary.capabilities.kind !== "declared") return [];

  const granted = summary.capabilities.capabilities.capabilities;
  const excess = excessCapabilities(granted, propagated.required.capabilities);
  const diagnostics: Diagnostic[] = [];

  if (excess.length > 0) {
    diagnostics.push(buildCapabilityEscalation(propagated, granted, excess, state, engine));
  }
  if (propagated.required.unknown) {
    const chain = capabilityUnknownWitnessChain(summary.id, state);
    const witness = chain[chain.length - 1];
    const witnessSummary = witness ? state.get(witness)?.summary : undefined;
    // Two different causes reach the same unknown, and saying the wrong one
    // sends a reader hunting for a call that resolved perfectly well.
    const cause =
      witnessSummary?.boundary.kind === "declared"
        ? `calls ${displayName(witnessSummary.id)}, a @boundary that declares no @capabilities`
        : "reaches a call that could not be resolved";
    diagnostics.push({
      id: "AMB-W003",
      severity: "warning",
      category: "capabilities",
      message: `${displayName(summary.id)} declares @capabilities but ${cause}, so its capability requirement is not fully known`,
      location: summary.location,
      contract: {
        declared: granted.map(formatCapability),
        required: propagated.required.capabilities.map(formatCapability),
        excess: [],
        via: chainToVia(chain, state),
      },
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-w003",
      engine,
    });
  }
  return diagnostics;
}

function buildCapabilityEscalation(
  propagated: PropagatedFunction,
  granted: readonly Capability[],
  excess: readonly Capability[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
  engine: DiagnosticEngine,
): Diagnostic {
  const { summary } = propagated;
  // Deterministic choice of which excess capability's path to show, so the
  // same code always produces the same diagnostic.
  const primary = [...excess].sort((a, b) =>
    formatCapability(a).localeCompare(formatCapability(b)),
  )[0];
  const chain = primary ? capabilityWitnessChain(summary.id, formatCapability(primary), state) : [];
  const via = chainToVia(chain, state);
  const grantedList = granted.map(formatCapability);
  const excessList = excess.map(formatCapability);

  const message =
    via.length > 0
      ? `${displayName(summary.id)} grants [${grantedList.join(", ")}] but calls ${displayName(via[via.length - 1]?.symbol ?? summary.id)} which requires [${excessList.join(", ")}]`
      : `${displayName(summary.id)} grants [${grantedList.join(", ")}] but requires [${excessList.join(", ")}]`;

  return {
    id: "AMB-E005",
    severity: "error",
    category: "capabilities",
    message,
    location: summary.location,
    contract: {
      declared: grantedList,
      required: propagated.required.capabilities.map(formatCapability),
      excess: excessList,
      via,
    },
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e005",
    engine,
  };
}

/**
 * `@boundary` is an explicit trust declaration (DESIGN.md §4.6). Two ways to
 * write one that does nothing, both reported rather than accepted:
 * a missing `reason`, and no contract to trust in its place.
 */
function diagnoseBoundary(
  propagated: PropagatedFunction,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.boundary.kind === "invalid") {
    return [
      {
        id: "AMB-E006",
        severity: "error",
        category: "boundary",
        message: `${displayName(summary.id)} declares @boundary "${summary.boundary.raw}", which does not give the required reason= (DESIGN.md §4.6)`,
        location: summary.location,
        fixes: [],
        docs: "docs/diagnostics/README.md#amb-e006",
        engine,
      },
    ];
  }
  if (summary.boundary.kind !== "declared") return [];
  // An `@effects` that failed to parse is already AMB-E002's business; saying
  // "no @effects" on top of it would name the wrong problem.
  if (summary.declared.kind !== "none") return [];

  return [
    {
      id: "AMB-E007",
      severity: "error",
      category: "boundary",
      message: `${displayName(summary.id)} declares @boundary but no @effects, so its body is not checked and nothing was declared in its place`,
      location: summary.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-e007",
      engine,
    },
  ];
}

function diagnoseBudget(
  propagated: PropagatedFunction,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (summary.budget.kind !== "invalid") return [];
  return [
    {
      id: "AMB-E008",
      severity: "error",
      category: "budget",
      message: `${displayName(summary.id)} declares @budget "${summary.budget.raw}", which is not a space-separated list of timeMs/costUsd/llmCalls limits with an optional onExceed=throw|warn|abort`,
      location: summary.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-e008",
      engine,
    },
  ];
}

/**
 * DESIGN.md §4.4: 「エントリポイントは `@entrypoint` と `@capabilities` を…
 * 明示する。未指定は unknown 相当として警告」. An entrypoint is where the
 * runtime establishes a capability context; one with no capability set
 * establishes nothing to check against.
 */
function diagnoseEntrypoint(
  propagated: PropagatedFunction,
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  const { summary } = propagated;
  if (!summary.entrypoint) return [];
  if (summary.capabilities.kind !== "none") return [];
  return [
    {
      id: "AMB-W002",
      severity: "warning",
      category: "capabilities",
      message: `${displayName(summary.id)} is an @entrypoint with no @capabilities, so the runtime has no capability set to establish for it`,
      location: summary.location,
      fixes: [],
      docs: "docs/diagnostics/README.md#amb-w002",
      engine,
    },
  ];
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

/** Why the node in question cannot carry a contract, for AMB-E003's message. */
const UNCARRIED_REASON: Record<SkippedFunctionKind, string> = {
  "getter-setter": "a getter/setter",
  "object-literal-method": "an object-literal member with no stable declaration path",
  "anonymous-default-export": "an anonymous default export",
  "callback-argument": "a callback passed inline as an argument",
  "nested-function": "a function declared inside another function",
  other: "a node the analysis does not extract",
};

/**
 * A contract tag written on a function-like node the backend does not extract
 * (DESIGN.md §4.1 permits `@effects` on 任意の関数・メソッド, but only an
 * extracted node has a `SymbolId` to hang one on). Reported rather than
 * dropped, on the same principle as AMB-E002: a declaration that silently does
 * nothing looks like a guarantee and is not one.
 */
export function diagnoseUncarriedContracts(
  uncarried: readonly UncarriedContract[],
  engine: DiagnosticEngine,
): readonly Diagnostic[] {
  return uncarried.map((contract) => ({
    id: "AMB-E003",
    severity: "error",
    category: "effects",
    message: `@${contract.tag} is declared on ${UNCARRIED_REASON[contract.kind]}, which cannot carry a contract — the declaration has no effect`,
    location: contract.location,
    fixes: [],
    docs: "docs/diagnostics/README.md#amb-e003",
    engine,
  }));
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
  const last = parts[parts.length - 1];
  if (last === undefined) return id;
  // A bare "constructor" names nothing — keep the class with it
  // (`Client.constructor`), since every class contributes one.
  if (last === "constructor" && parts.length >= 2) return `${parts[parts.length - 2]}.${last}`;
  return last;
}
