/**
 * What a generation changed, and how far it reaches — phase 3 of
 * `docs/resident-check-path.md`.
 *
 * Three pure functions over data the resident store already holds, with no
 * compiler, no filesystem and no session state in any of them:
 *
 * 1. {@link summariesEqual} — whether two `FunctionSummary` values are the same
 *    *analysis input*.
 * 2. {@link changedSymbols} — the changed set `S`.
 * 3. {@link impactClosure} — the impact set `I`, `S` closed under callers.
 *
 * **The comparator is where phase 3 can go wrong**, and the direction matters:
 * an over-wide comparison costs a recomputation, a narrow one reuses a
 * propagated value whose inputs moved and commits stale authority (§3.4 — an
 * `unknown` must never become "no violation" by omission). So every field of
 * `FunctionSummary` is compared, including the ones propagation does not read,
 * and the exhaustiveness is enforced by the compiler rather than by this
 * paragraph: each `…_FIELDS` record below is typed `Record<keyof T, true>`, so
 * adding a field to a summary or to a call kind fails `tsc --noEmit` until it
 * is named here.
 *
 * No `JSON.stringify` anywhere. A structural comparison written out is the only
 * form in which "what counts as the same function" can be read, reviewed and
 * argued with; a serialization would also silently decide `Map` and `Set`
 * ordering questions this file has to answer one field at a time.
 */

import type {
  Budget,
  Call,
  CapabilitySet,
  ContractDivergence,
  ContractOrigins,
  DeclaredBoundary,
  DeclaredBudget,
  DeclaredCapabilities,
  DeclaredEffects,
  EffectSet,
  FunctionSummary,
  SourceLocation,
  SymbolId,
} from "../core/index.ts";

// ---- exhaustiveness pins ---------------------------------------------------
//
// Each of these names every field of one shape. They are never read; they exist
// so that `tsc` refuses a shape that grew a field this file does not compare.
// `satisfies` rather than an annotation, so an extra key is an error too.

const SUMMARY_FIELDS = {
  id: true,
  location: true,
  tagLocations: true,
  declarationStart: true,
  jsDocRange: true,
  implicitConstructor: true,
  configOnly: true,
  undeclarable: true,
  declaredBy: true,
  divergences: true,
  declared: true,
  capabilities: true,
  budget: true,
  boundary: true,
  entrypoint: true,
  calls: true,
  bodies: true,
} satisfies Record<keyof FunctionSummary, true>;

const LOCATION_FIELDS = {
  file: true,
  line: true,
  col: true,
  endLine: true,
  endCol: true,
} satisfies Record<keyof SourceLocation, true>;

const BUDGET_FIELDS = {
  timeMs: true,
  costUsd: true,
  llmCalls: true,
  onExceed: true,
} satisfies Record<keyof Budget, true>;

const ORIGIN_FIELDS = {
  effects: true,
  capabilities: true,
  budget: true,
} satisfies Record<keyof ContractOrigins, true>;

const DIVERGENCE_FIELDS = {
  tag: true,
  jsDoc: true,
  config: true,
} satisfies Record<keyof ContractDivergence, true>;

/**
 * Every field of every {@link Call} kind, as one record per kind.
 *
 * Written per kind rather than as `keyof Call` (which is only the *shared*
 * keys) so that a new field on one kind — a second `StubCall` capability, say —
 * cannot slip past the compiler because the other five kinds do not have it.
 */
const CALL_FIELDS = {
  resolved: { kind: true, location: true, callee: true },
  stub: {
    kind: true,
    location: true,
    effects: true,
    qualifiedName: true,
    requiredCapability: true,
    capabilityTargetUnknown: true,
  },
  "known-pure": { kind: true, location: true, qualifiedName: true },
  inlined: { kind: true, location: true },
  unresolved: { kind: true, location: true, reason: true, qualifiedName: true },
  mutation: {
    kind: true,
    location: true,
    escaping: true,
    qualifiedName: true,
    unknownCallback: true,
  },
} satisfies { [K in Call["kind"]]: Record<keyof Extract<Call, { kind: K }>, true> };

void SUMMARY_FIELDS;
void LOCATION_FIELDS;
void BUDGET_FIELDS;
void ORIGIN_FIELDS;
void DIVERGENCE_FIELDS;
void CALL_FIELDS;

// ---- the comparator --------------------------------------------------------

/**
 * Whether two summaries are the same analysis input — the test that decides
 * whether a function's committed propagated value may be reused.
 *
 * Ordering, per field, stated rather than inherited from a serializer:
 *
 * - `calls` and `bodies`: **ordered**. Propagation reads them in order to pick
 *   the first witness for an effect or a capability, and `via` chains are part
 *   of the bytes §6.2 compares. Two identical call lists in a different order
 *   are a different summary here.
 * - `tagLocations`: **ordered** over its entries. A `Map`'s entry order is
 *   observable wherever it is iterated, and ordered is the conservative
 *   direction — it can only cost a recomputation.
 * - `declared.effects` / every `EffectSet`: **unordered**. It is a `Set` of a
 *   closed enum, and every consumer emits it through `KNOWN_EFFECTS.filter`,
 *   so its insertion order reaches no output.
 * - `capabilities` / every `CapabilitySet`: **unordered**. The array is a set
 *   with array representation (`unionCapabilitySets` de-duplicates by value),
 *   and `authority.ts` emits it `.toSorted()`.
 * - `divergences`: **ordered**. It is built in tag order and reported in that
 *   order as `AMB-W005`.
 * - Every `SourceLocation`: compared field by field. A function that only
 *   moved lines still has to be re-reported at its new position.
 */
export function summariesEqual(a: FunctionSummary, b: FunctionSummary): boolean {
  return (
    a.id === b.id &&
    locationsEqual(a.location, b.location) &&
    locationMapsEqual(a.tagLocations, b.tagLocations) &&
    locationsEqual(a.declarationStart, b.declarationStart) &&
    optionalLocationsEqual(a.jsDocRange, b.jsDocRange) &&
    a.implicitConstructor === b.implicitConstructor &&
    a.configOnly === b.configOnly &&
    a.undeclarable === b.undeclarable &&
    originsEqual(a.declaredBy, b.declaredBy) &&
    divergenceListsEqual(a.divergences, b.divergences) &&
    declaredEffectsEqual(a.declared, b.declared) &&
    declaredCapabilitiesEqual(a.capabilities, b.capabilities) &&
    declaredBudgetsEqual(a.budget, b.budget) &&
    declaredBoundariesEqual(a.boundary, b.boundary) &&
    a.entrypoint === b.entrypoint &&
    callListsEqual(a.calls, b.calls) &&
    bodiesEqual(a.bodies, b.bodies)
  );
}

function locationsEqual(a: SourceLocation, b: SourceLocation): boolean {
  return (
    a.file === b.file &&
    a.line === b.line &&
    a.col === b.col &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}

function optionalLocationsEqual(a?: SourceLocation, b?: SourceLocation): boolean {
  if (a === undefined || b === undefined) return a === b;
  return locationsEqual(a, b);
}

/** Ordered over entries — see {@link summariesEqual}. */
function locationMapsEqual(
  a: ReadonlyMap<string, SourceLocation>,
  b: ReadonlyMap<string, SourceLocation>,
): boolean {
  if (a.size !== b.size) return false;
  const left = [...a];
  const right = [...b];
  return left.every((entry, index) => {
    const other = right[index];
    if (!other) return false;
    return entry[0] === other[0] && locationsEqual(entry[1], other[1]);
  });
}

function originsEqual(a?: ContractOrigins, b?: ContractOrigins): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.effects === b.effects && a.capabilities === b.capabilities && a.budget === b.budget;
}

function divergenceListsEqual(
  a?: readonly ContractDivergence[],
  b?: readonly ContractDivergence[],
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((divergence, index) => {
    const other = b[index];
    if (!other) return false;
    return (
      divergence.tag === other.tag &&
      divergence.jsDoc === other.jsDoc &&
      divergence.config === other.config
    );
  });
}

/**
 * Unordered — an `EffectSet` is a `Set` over a closed enum and reaches every
 * output through `KNOWN_EFFECTS.filter`.
 *
 * Not delegated to `core`'s `effectSetsEqual` only where a *declaration* is
 * compared: there the tag's `kind` (`none` / `invalid` / `declared`) is part of
 * the answer, and `invalid` carries its raw text.
 */
function effectSetsSame(a: EffectSet, b: EffectSet): boolean {
  if (a.unknown !== b.unknown || a.effects.size !== b.effects.size) return false;
  for (const effect of a.effects) if (!b.effects.has(effect)) return false;
  return true;
}

/** Unordered — see {@link summariesEqual}. */
function capabilitySetsSame(a: CapabilitySet, b: CapabilitySet): boolean {
  if (a.unknown !== b.unknown || a.capabilities.length !== b.capabilities.length) return false;
  return a.capabilities.every((capability) =>
    b.capabilities.some(
      (other) =>
        other.resource === capability.resource &&
        other.action === capability.action &&
        other.target === capability.target,
    ),
  );
}

function declaredEffectsEqual(a: DeclaredEffects, b: DeclaredEffects): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "invalid" && b.kind === "invalid") return a.raw === b.raw;
  if (a.kind === "declared" && b.kind === "declared") return effectSetsSame(a.effects, b.effects);
  return true;
}

function declaredCapabilitiesEqual(a: DeclaredCapabilities, b: DeclaredCapabilities): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "invalid" && b.kind === "invalid") return a.raw === b.raw;
  if (a.kind === "declared" && b.kind === "declared")
    return capabilitySetsSame(a.capabilities, b.capabilities);
  return true;
}

function declaredBudgetsEqual(a: DeclaredBudget, b: DeclaredBudget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "invalid" && b.kind === "invalid") return a.raw === b.raw;
  if (a.kind === "declared" && b.kind === "declared") {
    return (
      a.budget.timeMs === b.budget.timeMs &&
      a.budget.costUsd === b.budget.costUsd &&
      a.budget.llmCalls === b.budget.llmCalls &&
      a.budget.onExceed === b.budget.onExceed
    );
  }
  return true;
}

function declaredBoundariesEqual(a: DeclaredBoundary, b: DeclaredBoundary): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "invalid" && b.kind === "invalid") return a.raw === b.raw;
  if (a.kind === "declared" && b.kind === "declared") return a.reason === b.reason;
  return true;
}

/** Ordered — see {@link summariesEqual}. */
function callListsEqual(a: readonly Call[], b: readonly Call[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((call, index) => {
    const other = b[index];
    return other !== undefined && callsEqual(call, other);
  });
}

function callsEqual(a: Call, b: Call): boolean {
  if (a.kind !== b.kind) return false;
  if (!locationsEqual(a.location, b.location)) return false;
  switch (a.kind) {
    case "resolved":
      return b.kind === "resolved" && a.callee === b.callee;
    case "stub":
      return (
        b.kind === "stub" &&
        a.qualifiedName === b.qualifiedName &&
        a.capabilityTargetUnknown === b.capabilityTargetUnknown &&
        // A stub's effects are a list, and one call site can carry several
        // (a `pool.query` whose direction the source does not fix). Compared
        // in order: it is produced by the stub table in a fixed order, so a
        // difference is a different table answer, not a reordering.
        a.effects.length === b.effects.length &&
        a.effects.every((effect, index) => effect === b.effects[index]) &&
        (a.requiredCapability === undefined || b.requiredCapability === undefined
          ? a.requiredCapability === b.requiredCapability
          : a.requiredCapability.resource === b.requiredCapability.resource &&
            a.requiredCapability.action === b.requiredCapability.action &&
            a.requiredCapability.target === b.requiredCapability.target)
      );
    case "known-pure":
      return b.kind === "known-pure" && a.qualifiedName === b.qualifiedName;
    case "inlined":
      return b.kind === "inlined";
    case "unresolved":
      return (
        b.kind === "unresolved" && a.reason === b.reason && a.qualifiedName === b.qualifiedName
      );
    case "mutation":
      return (
        b.kind === "mutation" &&
        a.escaping === b.escaping &&
        a.qualifiedName === b.qualifiedName &&
        a.unknownCallback === b.unknownCallback
      );
  }
}

/** Ordered, both the body list and each body's calls — see {@link summariesEqual}. */
function bodiesEqual(a?: readonly (readonly Call[])[], b?: readonly (readonly Call[])[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.length !== b.length) return false;
  return a.every((body, index) => {
    const other = b[index];
    return other !== undefined && callListsEqual(body, other);
  });
}

// ---- the changed set S -----------------------------------------------------

/**
 * `S`: every symbol whose analysis input is not what the previous generation
 * held.
 *
 * Three sources, and the third is the one the comparator above decides:
 *
 * - **Added** — an id the previous generation had no summary for.
 * - **Deleted** — an id the new generation has no summary for. It is in `S` so
 *   that {@link impactClosure}, walking the *old* reverse-call graph, reaches
 *   the callers that will now fall to `unresolved`.
 * - **Changed** — an id both generations hold, whose summaries are not
 *   {@link summariesEqual}.
 *
 * A summary that did not move is **not** in `S`, whatever else changed about
 * the project. A refused `ProjectFingerprint` says the compiler's own state
 * could not be reused; it says nothing about whether a given function's
 * extracted, resolved and summarized form moved, and treating it as though it
 * did would make phase 3 inert (`docs/resident-check-path.md`, lifecycle
 * step 1).
 */
export function changedSymbols(
  previous: ReadonlyMap<SymbolId, FunctionSummary>,
  next: ReadonlyMap<SymbolId, FunctionSummary>,
): ReadonlySet<SymbolId> {
  const changed = new Set<SymbolId>();
  for (const [id, summary] of next) {
    const before = previous.get(id);
    if (before === undefined || !summariesEqual(before, summary)) changed.add(id);
  }
  for (const id of previous.keys()) {
    if (!next.has(id)) changed.add(id);
  }
  return changed;
}

// ---- the impact set I ------------------------------------------------------

/**
 * `I = S ∪ { f | f reaches some element of S through the reverse call graph }`,
 * taken over the **union of the old and the new** reverse call graphs.
 *
 * Both graphs, because the new one alone cannot see a caller that *lost* its
 * edge to a changed callee — the edge it would be found through is only in the
 * old graph. (With `S` decided as above, such a caller is in `S` already: its
 * `calls` array changed, or its callee vanished and the call fell to
 * `unresolved`. The union is kept regardless: it costs one extra lookup per
 * visited node, and it is the half of the argument that does not depend on the
 * comparator being complete.)
 *
 * A BFS with a visited set, so a cycle — including self-recursion — is visited
 * once and costs nothing. Deleted ids are carried into `I` by `S`; the caller
 * drops them from the state.
 */
export function impactClosure(
  changed: ReadonlySet<SymbolId>,
  previousReverseCalls: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>,
  nextReverseCalls: ReadonlyMap<SymbolId, ReadonlySet<SymbolId>>,
): ReadonlySet<SymbolId> {
  const impacted = new Set<SymbolId>(changed);
  const queue = [...changed];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const graph of [previousReverseCalls, nextReverseCalls]) {
      for (const caller of graph.get(current) ?? []) {
        if (impacted.has(caller)) continue;
        impacted.add(caller);
        queue.push(caller);
      }
    }
  }
  return impacted;
}
