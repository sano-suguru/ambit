import type { EffectSet, FunctionSummary, KnownEffect, SymbolId } from "../core/index.ts";
import { effectSetOf, effectSetsEqual, unionEffectSets, unknownEffectSet } from "../core/index.ts";

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
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of summaries) {
      const next = deriveState(summary, byId, state);
      const previous = state.get(summary.id);
      if (!previous || !effectSetsEqual(previous.observed, next.observed)) {
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
    .map((call) => call.effect);
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

function deriveState(
  summary: FunctionSummary,
  byId: ReadonlyMap<SymbolId, FunctionSummary>,
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): PropagatedFunction {
  const direct = directEffects(summary);
  const hasDirectUnresolved = summary.calls.some((call) => call.kind === "unresolved");

  let merged: EffectSet = direct;
  const effectWitness = new Map<KnownEffect, SymbolId>();
  let unknownWitness: SymbolId | undefined;

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
  }

  return {
    summary,
    observed: merged,
    effectWitness,
    unknownWitness: hasDirectUnresolved ? undefined : unknownWitness,
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
