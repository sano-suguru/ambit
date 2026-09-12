import type {
  CapabilitySet,
  ContractViaEntry,
  EffectSet,
  FunctionSummary,
  KnownEffect,
  SymbolId,
} from "../core/index.ts";
import {
  callLeavesUnknown,
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
   * A requirement arises in two ways. It is inherited from a callee's
   * declaration — the narrowing rule between a caller's grant and a callee's
   * declaration — or it is produced directly, by a bundled operation whose
   * target the source fixes: a literal URL's host (§4.4's static half,
   * `src/stubs/http-capabilities.ts`). The same operation with a target the
   * source does not fix contributes `unknown` instead, never nothing.
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
  /**
   * The same two lattices computed over each owned body on its own, for a
   * symbol that owns more than one (`FunctionSummary.bodies` — today the
   * inline-callback owner, DESIGN.md §4.1 (a)). Absent wherever one body
   * holds the whole symbol, which includes an owner of exactly one: there the
   * symbol's own sets already say what that body holds, and a one-element
   * split would be the same statement written twice.
   *
   * Their union is {@link observed} / {@link required}, so nothing here
   * changes what the symbol holds. What it carries is *how many* of the
   * bodies hold each authority, which is what `ambit diff` compares (§6.3):
   * without it, a second body gaining an effect a first already had would be
   * a merge into silence — the one outcome §6.4 forbids.
   */
  readonly bodies?: readonly BodyAuthority[];
}

/** One owned body's own authority — see {@link PropagatedFunction.bodies}. */
export interface BodyAuthority {
  readonly observed: EffectSet;
  readonly required: CapabilitySet;
}

/**
 * Compute each function's transitive effect set by a worklist fixed point
 * over the call graph (DESIGN.md §4.2: "Cycles in the call graph are
 * propagated to a fixed point using strongly connected components or the
 * like"). Handles cycles by iterating to a stable state — no
 * strongly-connected-component precomputation, since `EffectSet` only grows
 * (union is monotonic) and the id space is finite, so this always
 * terminates.
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

  // One pass after the fixed point, never inside it: a body is not a callee,
  // so nothing propagates *from* one of these and the union already reached
  // above is what every caller sees. Splitting it per body only records which
  // of them each authority came from, against the final state.
  for (const summary of summaries) {
    if (!summary.bodies || summary.bodies.length < 2) continue;
    const propagated = state.get(summary.id);
    if (!propagated) continue;
    state.set(summary.id, {
      ...propagated,
      bodies: summary.bodies.map((calls) => {
        const derived = deriveState({ ...summary, calls }, byId, state);
        return { observed: derived.observed, required: derived.required };
      }),
    });
  }

  return state;
}

/**
 * The same fixed point, restricted to an impact set — phase 3 of
 * `docs/resident-check-path.md`.
 *
 * {@link propagate} above is untouched and stays the oracle: the differential
 * suite asserts this function's whole output against it, symbol for symbol.
 *
 * The contract the caller owes, and which this function does not re-derive:
 * **`impacted` must contain every symbol whose summary moved, and every caller
 * that reaches one through the call graph** — `changedSymbols` and
 * `impactClosure` in `src/checker/impact.ts` are what compute it. A symbol
 * outside `impacted` has, by construction, an unchanged summary and no callee
 * whose value changed, so its committed value is still its value.
 *
 * **Initialization is a reset, not a seed.** Every `f ∈ impacted` starts at
 * exactly what {@link propagate} initializes with — `observed =
 * directEffects(f)`, `required` empty, both witness maps empty — and never at
 * its previous value. Starting from the previous value and unioning upward
 * would be monotone in the wrong dimension: authority that a change *removed*
 * would survive as a value nothing can now lower, which is the one direction
 * §6.2's equivalence law cannot tolerate and the reason the differential
 * suite's revert rows exist.
 *
 * **Termination** is `propagate`'s own argument, restricted: values outside
 * `impacted` are fixed, values inside only grow under union, the effect set is
 * finite and the capability set is drawn from the finite set of strings the
 * summaries hold.
 *
 * The returned map is built by walking `summaries` in order, so its iteration
 * order is `propagate`'s — which the coverage report and the diagnostic order
 * are functions of.
 */
export function propagateScoped(input: {
  readonly summaries: readonly FunctionSummary[];
  readonly previous: ReadonlyMap<SymbolId, PropagatedFunction>;
  readonly impacted: ReadonlySet<SymbolId>;
}): ReadonlyMap<SymbolId, PropagatedFunction> {
  const { summaries, previous, impacted } = input;
  const byId = new Map(summaries.map((s) => [s.id, s] as const));
  const state = new Map<SymbolId, PropagatedFunction>();
  const scoped: FunctionSummary[] = [];

  for (const summary of summaries) {
    if (impacted.has(summary.id)) {
      scoped.push(summary);
      state.set(summary.id, {
        summary,
        observed: directEffects(summary),
        effectWitness: new Map(),
        required: emptyCapabilitySet(),
        capabilityWitness: new Map(),
      });
      continue;
    }
    const committed = previous.get(summary.id);
    if (!committed) {
      // A symbol with no committed value and no place in the impact set has no
      // value at all. Falling back to an initial one here would put an
      // un-propagated function into the output as though it had been analyzed
      // — "unknown" reported as "nothing found" (§3.4). The caller's impact set
      // is wrong, and the generation must not commit.
      throw new Error(
        `scoped propagation has no committed value for ${summary.id}, and it is not in the impact set`,
      );
    }
    // The *new* summary object, carrying the committed lattice values. The two
    // are interchangeable by `summariesEqual`, which is what put this symbol
    // outside the impact set; holding the new one means a field the comparator
    // does not read cannot reach the output stale either.
    state.set(summary.id, { ...committed, summary });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const summary of scoped) {
      const next = deriveState(summary, byId, state);
      const current = state.get(summary.id);
      if (
        !current ||
        !effectSetsEqual(current.observed, next.observed) ||
        !capabilitySetsEqual(current.required, next.required)
      ) {
        changed = true;
      }
      state.set(summary.id, next);
    }
  }

  // The per-body pass, after the fixed point and for the impact set only —
  // `propagate`'s own order and its own reason. A multi-body owner outside the
  // impact set keeps the split it committed: a body is not a callee, so the
  // split is a function of that owner's summary and of its callees' values,
  // and neither moved.
  for (const summary of scoped) {
    if (!summary.bodies || summary.bodies.length < 2) continue;
    const propagated = state.get(summary.id);
    if (!propagated) continue;
    state.set(summary.id, {
      ...propagated,
      bodies: summary.bodies.map((calls) => {
        const derived = deriveState({ ...summary, calls }, byId, state);
        return { observed: derived.observed, required: derived.required };
      }),
    });
  }

  return state;
}

/**
 * The capabilities a function's own body requires before anything is
 * propagated into it: what its bundled-operation call sites fix statically,
 * plus `unknown` when one of them has a target the source does not fix, or
 * when a call could not be resolved at all.
 */
function directCapabilities(summary: FunctionSummary): CapabilitySet {
  let set: CapabilitySet = emptyCapabilitySet();
  let unknown = false;
  for (const call of summary.calls) {
    if (callLeavesUnknown(call)) {
      unknown = true;
      continue;
    }
    if (call.kind !== "stub") continue;
    if (call.requiredCapability) {
      set = unionCapabilitySets(set, {
        capabilities: [call.requiredCapability],
        unknown: false,
      });
    }
    if (call.capabilityTargetUnknown) unknown = true;
  }
  return unknown ? { capabilities: set.capabilities, unknown: true } : set;
}

function directEffects(summary: FunctionSummary): EffectSet {
  const stubEffects = summary.calls
    .filter((call) => call.kind === "stub")
    .flatMap((call) => call.effects);
  let set = effectSetOf(...stubEffects);
  // A mutation whose receiver is reachable from outside the function is a
  // direct `state_write` (DESIGN.md §4.2, "Local mutation and `pure`"); a local
  // one is recorded as a site but contributes nothing.
  if (summary.calls.some((call) => call.kind === "mutation" && call.escaping)) {
    set = unionEffectSets(set, effectSetOf("state_write"));
  }
  if (summary.calls.some(callLeavesUnknown)) {
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
 * what makes "undeclared = unknown" workable as a coverage concept rather
 * than a propagation rule — DESIGN.md §4.2 states it directly: "Undeclared"
 * and "`unknown`" are not the same thing.
 * A declared tag never carries `unknown` itself, so trusting it means a
 * callee's own undeclared internal `unknown` does not leak to callers; it
 * stays that callee's own AMB-W001, not its callers'.
 *
 * An *undeclared* callee has no signature to trust, so its own
 * recursively-inferred `observed` set is used instead — this is what lets
 * inference cross undeclared code (§4.3, incremental adoption).
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
 * propagated through (DESIGN.md §4.6: "do not statically check inside this
 * function; trust the effects and capabilities it declares outward").
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
  const hasDirectUnresolved = summary.calls.some(callLeavesUnknown);

  let merged: EffectSet = direct;
  const directRequired = directCapabilities(summary);
  // A capability requirement can go unknown right here — an unresolved call,
  // or a bundled operation whose target the source does not fix — in which
  // case there is no callee to name as the witness.
  const hasDirectCapabilityUnknown = directRequired.unknown;
  let required: CapabilitySet = directRequired;
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
      !hasDirectCapabilityUnknown &&
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
    capabilityUnknownWitness: hasDirectCapabilityUnknown ? undefined : capabilityUnknownWitness,
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

/**
 * A witness chain rendered as `contract.via` entries: each hop named by its
 * symbol id and located at its own declaration (DESIGN.md §5.1 — "`via` is a
 * sequence of functions, and each element's position is that function's
 * declaration position").
 *
 * Lives beside the chain walkers rather than beside either consumer, because
 * a diagnostic's path and an authority record's path must be the same path.
 */
export function chainToVia(
  chain: readonly SymbolId[],
  state: ReadonlyMap<SymbolId, PropagatedFunction>,
): readonly ContractViaEntry[] {
  return chain.map((id) => {
    const location = state.get(id)?.summary.location;
    return { symbol: id, file: location?.file ?? "", line: location?.line ?? 0 };
  });
}
