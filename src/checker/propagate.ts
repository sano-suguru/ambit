import type {
  CapabilitySet,
  EffectSet,
  FunctionSummary,
  KnownEffect,
  SymbolId,
} from "../core/index.ts";
import {
  capabilitySetsEqual,
  effectSetOf,
  effectSetsEqual,
  emptyCapabilitySet,
  formatCapability,
  unionCapabilitySets,
  unionEffectSets,
  unknownCapabilitySet,
  unknownEffectSet,
} from "../core/index.ts";

/** One function's propagated (transitive) effects, plus provenance for diagnostics. */
export interface PropagatedFunction {
  readonly summary: FunctionSummary;
  readonly observed: EffectSet;
  /**
   * For an effect in `observed` that this function does not produce
   * directly, the immediate callee it was inherited through. Absent for an
   * effect this function produces itself (a direct stub call).
   */
  readonly effectWitness: ReadonlyMap<KnownEffect, SymbolId>;
  /** The immediate callee `unknown` was inherited through, if not direct. */
  readonly unknownWitness?: SymbolId;
  /**
   * The capabilities this function's body needs (DESIGN.md §4.4). A second
   * lattice over the same call graph, with the same trust rule as effects: a
   * callee that declares `@capabilities` contributes what it declared, and an
   * undeclared one contributes what its own body was inferred to need — so a
   * grant checks through an undeclared middle function.
   *
   * Nothing produces a capability requirement directly yet. §4.4's static
   * side ("リテラル URL や既知クライアントなど静的に判定できる違反") needs
   * the connector layer to surface a stub call's literal arguments, which it
   * does not do; until then every requirement is inherited from a declaration
   * somewhere below, and the check that runs is the 縮小則 between a caller's
   * grant and a callee's declaration.
   */
  readonly required: CapabilitySet;
  /** For a required capability this function does not declare itself, the immediate callee it came through. */
  readonly capabilityWitness: ReadonlyMap<string, SymbolId>;
  /**
   * The immediate callee an *unknown capability requirement* came through, if
   * not direct. Tracked apart from {@link unknownWitness} because the two have
   * different causes: effects go unknown at an unresolved call, while
   * capabilities also go unknown at a perfectly resolved `@boundary` callee
   * that declared no `@capabilities`. Reporting the second as "reaches a call
   * that could not be resolved" would send a reader hunting for an unresolved
   * call that does not exist.
   */
  readonly capabilityUnknownWitness?: SymbolId;
}

/**
 * Compute each function's transitive effect set by a worklist fixed point
 * over the call graph (DESIGN.md §4.2: "呼び出し関係の循環は...固定点に
 * 達するまで伝播させる"). Handles cycles by iterating to a stable state —
 * no strongly-connected-component precomputation, since `EffectSet` only
 * grows (union is monotonic) and the id space is finite, so this always
 * terminates (plan: "循環は素朴な worklist 反復で収束させる").
 */
export function propagate(
  summaries: readonly FunctionSummary[],
): ReadonlyMap<SymbolId, PropagatedFunction> {
  const byId = new Map(summaries.map((s) => [s.id, s] as const));
  const state = new Map<SymbolId, PropagatedFunction>();

  for (const summary of summaries) {
    state.set(summary.id, {
      summary,
      observed: directEffects(summary),
      effectWitness: new Map(),
      required: emptyCapabilitySet(),
      capabilityWitness: new Map(),
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) {
      const next = deriveState(summary, byId, state);
      const previous = state.get(summary.id);
      if (
        !previous ||
        !effectSetsEqual(previous.observed, next.observed) ||
        !capabilitySetsEqual(previous.required, next.required)
      ) {
        changed = true;
      }
      state.set(summary.id, next);
    }
  }

  return state;
}

function directEffects(summary: FunctionSummary): EffectSet {
  const stubEffects = summary.calls
    .filter((call) => call.kind === "stub")
    .flatMap((call) => call.effects);
  let set = effectSetOf(...stubEffects);
  if (summary.calls.some((call) => call.kind === "unresolved")) {
    set = unionEffectSets(set, unknownEffectSet());
  }
  return set;
}

/**
 * What a caller inherits from a resolved call to `calleeSummary`.
 *
 * A *declared* callee is a trust boundary: its own body is checked against
 * its own declaration by `diagnose.ts` (independently, on that function's
 * own record), and callers propagate the declared set rather than the
 * callee's inferred one. This is the usual modular-typing shape (a
 * function's signature, not its body, is what callers see) and is also
 * what makes "未宣言 = unknown" workable as a coverage concept rather than
 * a propagation rule — see the plan's note on DESIGN.md §4.2/§4.3.
 * A declared tag never carries `unknown` itself, so trusting it means a
 * callee's own undeclared internal `unknown` does not leak to callers; it
 * stays that callee's own AMB-W001, not its callers'.
 *
 * An *undeclared* callee has no signature to trust, so its own
 * recursively-inferred `observed` set is used instead — this is what lets
 * inference cross undeclared code (§4.3 "段階的導入").
 */
function contributionOf(
  calleeSummary: FunctionSummary,
  calleeState: PropagatedFunction,
): EffectSet {
  if (calleeSummary.declared.kind === "declared") return calleeSummary.declared.effects;
  return calleeState.observed;
}

/** The capability requirement a caller inherits from a resolved call. Same trust rule as {@link contributionOf}. */
function capabilityContributionOf(
  calleeSummary: FunctionSummary,
  calleeState: PropagatedFunction,
): CapabilitySet {
  if (calleeSummary.capabilities.kind === "declared")
    return calleeSummary.capabilities.capabilities;
  return calleeState.required;
}

/**
 * A `@boundary` function's contract is taken as written and its body is not
 * propagated through (DESIGN.md §4.6: 「この関数の中は静的検査しない。外側に
 * 対して宣言したエフェクト・ケイパビリティを信じる」).
 *
 * What it declares is what it contributes. What it does *not* declare is
 * `unknown`, not empty: the body was excluded from analysis, so an
 * undeclared dimension is unexamined, and calling it "requires nothing"
 * would turn an explicit hole into a guarantee (P4).
 */
function boundaryState(summary: FunctionSummary): PropagatedFunction {
  return {
    summary,
    observed: summary.declared.kind === "declared" ? summary.declared.effects : unknownEffectSet(),
    effectWitness: new Map(),
    required:
      summary.capabilities.kind === "declared"
        ? summary.capabilities.capabilities
        : unknownCapabilitySet(),
    capabilityWitness: new Map(),
  };
}

function deriveState(
  summary: FunctionSummary,
  byId: ReadonlyMap<SymbolId, FunctionSummary>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): PropagatedFunction {
  if (summary.boundary.kind === "declared") return boundaryState(summary);

  const direct = directEffects(summary);
  const hasDirectUnresolved = summary.calls.some((call) => call.kind === "unresolved");

  let merged: EffectSet = direct;
  let required: CapabilitySet = hasDirectUnresolved ? unknownCapabilitySet() : emptyCapabilitySet();
  const effectWitness = new Map<KnownEffect, SymbolId>();
  const capabilityWitness = new Map<string, SymbolId>();
  let unknownWitness: SymbolId | undefined;
  let capabilityUnknownWitness: SymbolId | undefined;

  for (const call of summary.calls) {
    if (call.kind !== "resolved") continue;
    const calleeSummary = byId.get(call.callee);
    const calleeState = state.get(call.callee);
    if (!calleeSummary || !calleeState) continue; // defensive: should always resolve within the same summary set

    const contribution = contributionOf(calleeSummary, calleeState);
    merged = unionEffectSets(merged, contribution);

    for (const effect of contribution.effects) {
      if (!direct.effects.has(effect) && !effectWitness.has(effect)) {
        effectWitness.set(effect, call.callee);
      }
    }
    if (contribution.unknown && !hasDirectUnresolved && unknownWitness === undefined) {
      unknownWitness = call.callee;
    }

    const capabilityContribution = capabilityContributionOf(calleeSummary, calleeState);
    required = unionCapabilitySets(required, capabilityContribution);
    for (const capability of capabilityContribution.capabilities) {
      const key = formatCapability(capability);
      if (!capabilityWitness.has(key)) capabilityWitness.set(key, call.callee);
    }
    if (
      capabilityContribution.unknown &&
      !hasDirectUnresolved &&
      capabilityUnknownWitness === undefined
    ) {
      capabilityUnknownWitness = call.callee;
    }
  }

  return {
    summary,
    observed: merged,
    effectWitness,
    unknownWitness: hasDirectUnresolved ? undefined : unknownWitness,
    required,
    capabilityWitness,
    capabilityUnknownWitness: hasDirectUnresolved ? undefined : capabilityUnknownWitness,
  };
}

/** Walk `effectWitness` chains from `start` to the function that produces `effect` directly. */
export function witnessChain(
  start: SymbolId,
  effect: KnownEffect,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly SymbolId[] {
  const chain: SymbolId[] = [];
  let current = start;
  const visited = new Set<SymbolId>([current]);
  for (;;) {
    const next = state.get(current)?.effectWitness.get(effect);
    if (next === undefined || visited.has(next)) return chain;
    chain.push(next);
    visited.add(next);
    current = next;
  }
}

/** Walk `capabilityUnknownWitness` from `start` to the function whose capability requirement first went unknown. */
export function capabilityUnknownWitnessChain(
  start: SymbolId,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly SymbolId[] {
  const chain: SymbolId[] = [];
  let current = start;
  const visited = new Set<SymbolId>([current]);
  for (;;) {
    const next = state.get(current)?.capabilityUnknownWitness;
    if (next === undefined || visited.has(next)) return chain;
    chain.push(next);
    visited.add(next);
    current = next;
  }
}

/** Walk `capabilityWitness` chains from `start` to the function that declares `capability`. */
export function capabilityWitnessChain(
  start: SymbolId,
  capability: string,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly SymbolId[] {
  const chain: SymbolId[] = [];
  let current = start;
  const visited = new Set<SymbolId>([current]);
  for (;;) {
    const next = state.get(current)?.capabilityWitness.get(capability);
    if (next === undefined || visited.has(next)) return chain;
    chain.push(next);
    visited.add(next);
    current = next;
  }
}

/** Walk `unknownWitness` chain from `start` to the function with the direct unresolved call. */
export function unknownWitnessChain(
  start: SymbolId,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly SymbolId[] {
  const chain: SymbolId[] = [];
  let current = start;
  const visited = new Set<SymbolId>([current]);
  for (;;) {
    const next = state.get(current)?.unknownWitness;
    if (next === undefined || visited.has(next)) return chain;
    chain.push(next);
    visited.add(next);
    current = next;
  }
}
