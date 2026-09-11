/**
 * Comparing two backends' runs over one tree.
 *
 * Pure over {@link ShadowFacts}: two normalized runs in, a report out. It
 * loads no compiler and reads no file, so `test/shadow.compare.test.ts` can
 * exercise every divergence category — including the identity case, legacy
 * against itself, which must produce none — without the native engine
 * installed.
 *
 * Two rules shape the output, and both exist so the parity numbers mean
 * something:
 *
 * - **Direction is recorded, not just difference.** A shadow backend that
 *   reports *less* authority, or *less* `unknown`, than the authoritative one
 *   is the dangerous direction: it is the shape in which a real effect
 *   disappears and a check passes that should not (DESIGN.md §3.4). Those are
 *   `risk: "high"`, listed first, and their count is printed even when it is
 *   zero — an absent number reads as "not measured".
 * - **"Not yet ported" is not "disagrees".** The shadow backend implements a
 *   subset (`NOT_PORTED` in `native-ts7-backend.ts`); a divergence that lands
 *   in one of those shapes is a gap in this port, and saying so is what keeps
 *   the remaining divergences worth investigating. Nothing is classified as
 *   one compiler being *wrong* without a root-cause line, so
 *   `ts6-suspect`/`ts7-suspect` are only ever written by hand into
 *   {@link KNOWN_DIVERGENCES}.
 */

import type { AuthorityRecord, AuthorityRef, SymbolId } from "../../src/core/index.ts";
import { authorityIncreases, diffAuthority } from "../../src/core/index.ts";
import type { CallFacts, ShadowFacts, SummaryCallFacts } from "./normalize.ts";

export type DivergenceCategory =
  | "function"
  | "callee-resolution"
  | "call-edge"
  | "unresolved-classification"
  | "direct-effect"
  | "propagated-effect"
  | "capability"
  | "authority"
  | "diagnostic"
  | "skipped-function"
  | "uncarried-contract"
  | "runtime-wrapper"
  | "ci-decision"
  | "backend-error";

/**
 * Which way the shadow backend differs. `shadow-less-*` is the unsafe
 * direction; `shadow-more-*` overstates and is merely noisy.
 */
export type DivergenceDirection =
  | "shadow-missing"
  | "shadow-extra"
  | "shadow-less-authority"
  | "shadow-more-authority"
  | "shadow-less-unknown"
  | "shadow-more-unknown"
  | "target-mismatch"
  | "value-mismatch";

export type DivergenceClassification =
  | "not-yet-ported"
  | "ts7-api-gap"
  | "ts6-suspect"
  | "ts7-suspect"
  | "unclassified";

export interface Divergence {
  readonly category: DivergenceCategory;
  readonly direction: DivergenceDirection;
  readonly risk: "high" | "normal";
  readonly symbol?: SymbolId;
  readonly location?: string;
  /** The authoritative (TypeScript 6) value, rendered. `null` where it had none. */
  readonly authorityValue: string | null;
  /** The shadow (TypeScript 7) value, rendered. `null` where it had none. */
  readonly shadowValue: string | null;
  readonly classification: DivergenceClassification;
  /** Why it is classified as it is. Required for anything but `unclassified`. */
  readonly note?: string;
}

/**
 * Divergences whose root cause has been found, keyed by a substring of the
 * rendered pair. Each entry is a claim about *why* two compilers differ, so
 * each carries the evidence line that justifies it — never a guess to make a
 * number look better.
 *
 * A rule matches when `whenAuthorityIncludes` (if given) appears in the
 * authoritative value and `whenShadowIncludes` (if given) appears in the
 * shadow value.
 */
export interface KnownDivergence {
  readonly category: DivergenceCategory;
  readonly whenAuthorityIncludes?: string;
  readonly whenShadowIncludes?: string;
  readonly classification: DivergenceClassification;
  readonly note: string;
}

export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    category: "callee-resolution",
    whenAuthorityIncludes: "resolved=",
    whenShadowIncludes: "unresolvedReason=",
    classification: "not-yet-ported",
    note:
      "resolution:literal-receiver / resolution:instance-member are not ported (NOT_PORTED): " +
      "the adopted backend follows a receiver whose value is certainly one object literal or one " +
      "constructed instance, the shadow backend does not and falls to the reason the callee's own " +
      "declaration gives",
  },
  {
    category: "callee-resolution",
    whenAuthorityIncludes: "name=",
    whenShadowIncludes: "unresolvedReason=",
    classification: "not-yet-ported",
    note:
      "qualified-name:installed-type-receiver / :constructed-receiver / :factory-receiver are not " +
      "ported (NOT_PORTED): the adopted backend names a receiver by the package type or class it " +
      "came from, the shadow backend names only a namespace or default import",
  },
  {
    // Both sides call the site unresolved for the same reason; only the
    // *name* the report carries differs, because the shadow backend could not
    // produce a receiver-origin qualified name. The effect outcome is
    // identical — this costs the `--coverage` breakdown a name, not a verdict.
    category: "direct-effect",
    whenAuthorityIncludes: "kind=unresolved",
    whenShadowIncludes: "operation=-",
    classification: "not-yet-ported",
    note: "the operation name comes from a receiver-origin qualified name (NOT_PORTED); both sides agree the site is unresolved",
  },
  {
    category: "direct-effect",
    whenAuthorityIncludes: "kind=stub",
    whenShadowIncludes: "kind=unresolved",
    classification: "not-yet-ported",
    note: "the stub match the adopted backend gets from a receiver-origin qualified name (NOT_PORTED)",
  },
  {
    category: "call-edge",
    whenAuthorityIncludes: "present",
    whenShadowIncludes: "",
    classification: "not-yet-ported",
    note: "an edge the adopted backend gets from resolution:literal-receiver / resolution:instance-member",
  },
];

export interface ParityCount {
  readonly authorityOnly: number;
  readonly shadowOnly: number;
  readonly agreed: number;
  readonly disagreed: number;
  /** `agreed / (agreed + disagreed + authorityOnly + shadowOnly)`, or 1 when there is nothing to compare. */
  readonly rate: number;
}

export interface ShadowReport {
  readonly schema: "ambit-shadow-report/1";
  readonly root: string;
  readonly authorityBackend: ShadowFacts["backend"];
  readonly shadowBackend: ShadowFacts["backend"];
  readonly notPorted: readonly string[];
  readonly errors: readonly {
    readonly backend: string;
    readonly phase: string;
    readonly message: string;
  }[];
  readonly timings: {
    readonly authorityMs: number;
    readonly shadowMs: number;
    /** shadow / authority. Below 1 means the shadow backend was faster. */
    readonly ratio: number;
  };
  readonly parity: {
    readonly functions: ParityCount;
    readonly calleeResolution: ParityCount;
    readonly callEdges: ParityCount;
    readonly unresolvedClassification: ParityCount;
    readonly directEffects: ParityCount;
    readonly propagatedEffects: ParityCount;
    readonly capabilities: ParityCount;
    readonly authority: ParityCount;
    readonly diagnostics: ParityCount;
    readonly runtimeWrappers: ParityCount;
  };
  readonly authorityDiff: {
    /** Symbols where the shadow backend grants authority the authoritative one did not. */
    readonly increases: number;
    /** Symbols where it grants less — the direction that can hide a real effect. */
    readonly decreases: number;
    readonly unknownGained: number;
    readonly unknownLost: number;
  };
  readonly decision: {
    readonly authorityWouldPass: boolean;
    readonly shadowWouldPass: boolean;
    readonly agree: boolean;
  };
  readonly unknownRate: {
    readonly authority: number;
    readonly shadow: number;
    readonly delta: number;
  };
  readonly highRiskCount: number;
  readonly divergences: readonly Divergence[];
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function parity(
  agreed: number,
  disagreed: number,
  authorityOnly: number,
  shadowOnly: number,
): ParityCount {
  const total = agreed + disagreed + authorityOnly + shadowOnly;
  return {
    authorityOnly,
    shadowOnly,
    agreed,
    disagreed,
    rate: total === 0 ? 1 : agreed / total,
  };
}

function classify(
  category: DivergenceCategory,
  authorityValue: string | null,
  shadowValue: string | null,
): { classification: DivergenceClassification; note?: string } {
  for (const rule of KNOWN_DIVERGENCES) {
    if (rule.category !== category) continue;
    if (
      rule.whenAuthorityIncludes &&
      !(authorityValue ?? "").includes(rule.whenAuthorityIncludes)
    ) {
      continue;
    }
    if (rule.whenShadowIncludes && !(shadowValue ?? "").includes(rule.whenShadowIncludes)) continue;
    return { classification: rule.classification, note: rule.note };
  }
  return { classification: "unclassified" };
}

function divergence(
  input: Omit<Divergence, "classification" | "note" | "risk"> & {
    readonly risk?: "high" | "normal";
  },
): Divergence {
  const { classification, note } = classify(
    input.category,
    input.authorityValue,
    input.shadowValue,
  );
  const risk =
    input.risk ??
    (input.direction === "shadow-less-authority" || input.direction === "shadow-less-unknown"
      ? "high"
      : "normal");
  return { ...input, risk, classification, ...(note ? { note } : {}) };
}

/** Compare two keyed sets of rendered values, one divergence per key that differs. */
function compareKeyed(
  category: DivergenceCategory,
  authority: ReadonlyMap<string, string>,
  shadow: ReadonlyMap<string, string>,
  describe: (key: string) => { symbol?: SymbolId; location?: string },
): { readonly divergences: readonly Divergence[]; readonly count: ParityCount } {
  const divergences: Divergence[] = [];
  let agreed = 0;
  let disagreed = 0;
  let authorityOnly = 0;
  let shadowOnly = 0;

  for (const [key, authorityValue] of authority) {
    const shadowValue = shadow.get(key);
    if (shadowValue === undefined) {
      authorityOnly++;
      divergences.push(
        divergence({
          category,
          direction: "shadow-missing",
          risk: "high",
          ...describe(key),
          authorityValue,
          shadowValue: null,
        }),
      );
    } else if (shadowValue === authorityValue) {
      agreed++;
    } else {
      disagreed++;
      divergences.push(
        divergence({
          category,
          direction: "value-mismatch",
          ...describe(key),
          authorityValue,
          shadowValue,
        }),
      );
    }
  }
  for (const [key, shadowValue] of shadow) {
    if (authority.has(key)) continue;
    shadowOnly++;
    divergences.push(
      divergence({
        category,
        direction: "shadow-extra",
        ...describe(key),
        authorityValue: null,
        shadowValue,
      }),
    );
  }
  return { divergences, count: parity(agreed, disagreed, authorityOnly, shadowOnly) };
}

function callKey(call: CallFacts | SummaryCallFacts): string {
  return `${call.owner} ${call.location} #${call.ordinal}`;
}

function describeCallKey(key: string): { symbol?: SymbolId; location?: string } {
  const [symbol, location] = key.split(" ");
  return { symbol: symbol as SymbolId, ...(location ? { location } : {}) };
}

function calleeResolutionOf(call: CallFacts): string {
  if (call.resolvedCallee) return `resolved=${call.resolvedCallee}`;
  if (call.inlinedCallee) return "inlined";
  if (call.calleeQualifiedName) return `name=${call.calleeQualifiedName}`;
  if (call.pureBuiltinName) return `builtin=${call.pureBuiltinName}`;
  if (call.mutation) return `mutation=${call.mutation}`;
  return `unresolvedReason=${call.unresolvedReason ?? "none"}`;
}

function unresolvedClassificationOf(call: CallFacts): string {
  return [
    `reason=${call.unresolvedReason ?? "-"}`,
    call.callbackByReference ? "callbackByReference" : "",
    call.inlinedCallee ? "inlined" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function mapOf<T>(items: readonly T[], key: (item: T) => string, value: (item: T) => string) {
  const map = new Map<string, string>();
  for (const item of items) map.set(key(item), value(item));
  return map;
}

function authorityEffectsOf(record: AuthorityRecord): string {
  const effects = record.effects;
  return `declared=${effects.declared === null ? "-" : `[${[...effects.declared].toSorted(byString).join(",")}]`} observed=[${[...effects.observed].toSorted(byString).join(",")}] unknown=${effects.unknown}`;
}

function authorityCapabilitiesOf(record: AuthorityRecord): string {
  const capabilities = record.capabilities;
  return `declared=${capabilities.declared === null ? "-" : `[${[...capabilities.declared].toSorted(byString).join(",")}]`} required=[${[...capabilities.required].toSorted(byString).join(",")}] unknown=${capabilities.unknown}`;
}

export interface CompareInput {
  readonly root: string;
  readonly authority: ShadowFacts;
  readonly shadow: ShadowFacts;
  readonly notPorted: readonly string[];
  readonly errors?: readonly {
    readonly backend: string;
    readonly phase: string;
    readonly message: string;
  }[];
}

export function compareFacts(input: CompareInput): ShadowReport {
  const { authority, shadow } = input;
  const divergences: Divergence[] = [];

  // --- functions ----------------------------------------------------------
  const functions = compareKeyed(
    "function",
    mapOf(
      authority.functions,
      (fn) => fn.symbol,
      (fn) =>
        `location=${fn.location} declarationStart=${fn.declarationStart} jsDocRange=${fn.jsDocRange ?? "-"} tags=[${fn.jsDocTags.join(";")}] flags=[${fn.flags.join(",")}] bodies=${fn.bodyCount}`,
    ),
    mapOf(
      shadow.functions,
      (fn) => fn.symbol,
      (fn) =>
        `location=${fn.location} declarationStart=${fn.declarationStart} jsDocRange=${fn.jsDocRange ?? "-"} tags=[${fn.jsDocTags.join(";")}] flags=[${fn.flags.join(",")}] bodies=${fn.bodyCount}`,
    ),
    (key) => ({ symbol: key as SymbolId }),
  );
  divergences.push(...functions.divergences);

  // --- callee resolution --------------------------------------------------
  const calleeResolution = compareKeyed(
    "callee-resolution",
    mapOf(authority.calls, callKey, calleeResolutionOf),
    mapOf(shadow.calls, callKey, calleeResolutionOf),
    describeCallKey,
  );
  divergences.push(...calleeResolution.divergences);

  // --- call-graph edges ---------------------------------------------------
  const callEdges = compareKeyed(
    "call-edge",
    mapOf(
      authority.callEdges,
      (edge) => edge,
      () => "present",
    ),
    mapOf(
      shadow.callEdges,
      (edge) => edge,
      () => "present",
    ),
    (key) => ({ symbol: key.split(" ")[0] as SymbolId }),
  );
  divergences.push(...callEdges.divergences);

  // --- unresolved / unknown classification --------------------------------
  const unresolvedClassification = compareKeyed(
    "unresolved-classification",
    mapOf(authority.calls, callKey, unresolvedClassificationOf),
    mapOf(shadow.calls, callKey, unresolvedClassificationOf),
    describeCallKey,
  );
  divergences.push(...unresolvedClassification.divergences);

  // --- direct effects / capabilities (per summarized call) -----------------
  const directEffects = compareKeyed(
    "direct-effect",
    mapOf(
      authority.summaryCalls,
      callKey,
      (call) =>
        `kind=${call.kind} effects=[${call.effects.join(",")}] capabilities=[${call.capabilities.join(",")}] reason=${call.reason ?? "-"} operation=${call.operation ?? "-"}`,
    ),
    mapOf(
      shadow.summaryCalls,
      callKey,
      (call) =>
        `kind=${call.kind} effects=[${call.effects.join(",")}] capabilities=[${call.capabilities.join(",")}] reason=${call.reason ?? "-"} operation=${call.operation ?? "-"}`,
    ),
    describeCallKey,
  );
  divergences.push(...directEffects.divergences);

  // --- propagated effects / capabilities ----------------------------------
  const propagatedEffects = compareKeyed(
    "propagated-effect",
    mapOf(authority.authority, (record) => record.symbol, authorityEffectsOf),
    mapOf(shadow.authority, (record) => record.symbol, authorityEffectsOf),
    (key) => ({ symbol: key as SymbolId }),
  );
  divergences.push(...propagatedEffects.divergences);

  const capabilities = compareKeyed(
    "capability",
    mapOf(authority.authority, (record) => record.symbol, authorityCapabilitiesOf),
    mapOf(shadow.authority, (record) => record.symbol, authorityCapabilitiesOf),
    (key) => ({ symbol: key as SymbolId }),
  );
  divergences.push(...capabilities.divergences);

  // --- authority, through Ambit's own comparison --------------------------
  // `diffAuthority` is what `ambit diff` runs; giving it the authoritative
  // side as base and the shadow side as head asks exactly the question that
  // matters — would swapping backends change what a review sees.
  const diff = diffAuthority(authority.authority, shadow.authority);
  let authorityAgreed = 0;
  let authorityDisagreed = 0;
  let increases = 0;
  let decreases = 0;
  let unknownGained = 0;
  let unknownLost = 0;
  for (const symbol of diff.symbols) {
    const changed =
      symbol.added.length > 0 ||
      symbol.removed.length > 0 ||
      symbol.unknownGained ||
      symbol.unknownLost ||
      symbol.status !== "present";
    if (!changed) {
      authorityAgreed++;
      continue;
    }
    authorityDisagreed++;
    if (symbol.added.length > 0) increases++;
    if (symbol.removed.length > 0) decreases++;
    if (symbol.unknownGained) unknownGained++;
    if (symbol.unknownLost) unknownLost++;
    const direction: DivergenceDirection =
      symbol.removed.length > 0
        ? "shadow-less-authority"
        : symbol.added.length > 0
          ? "shadow-more-authority"
          : symbol.unknownLost
            ? "shadow-less-unknown"
            : "shadow-more-unknown";
    divergences.push(
      divergence({
        category: "authority",
        direction,
        symbol: symbol.symbol,
        authorityValue: `status=${symbol.status} removed=[${symbol.removed.map(renderRef).join(",")}]`,
        shadowValue: `added=[${symbol.added.map(renderRef).join(",")}] unknownGained=${symbol.unknownGained} unknownLost=${symbol.unknownLost}`,
      }),
    );
  }
  // Recomputed off the same diff rather than counted above, so the number the
  // summary prints and the one `ambit diff` would print cannot drift.
  increases = authorityIncreases(diff).length;

  // --- diagnostics, wrappers, skipped, uncarried --------------------------
  const diagnostics = compareKeyed(
    "diagnostic",
    mapOf(
      authority.diagnostics,
      (line) => line,
      () => "present",
    ),
    mapOf(
      shadow.diagnostics,
      (line) => line,
      () => "present",
    ),
    () => ({}),
  );
  divergences.push(...diagnostics.divergences);

  const runtimeWrappers = compareKeyed(
    "runtime-wrapper",
    mapOf(
      authority.runtimeWrappers,
      (line) => line,
      () => "present",
    ),
    mapOf(
      shadow.runtimeWrappers,
      (line) => line,
      () => "present",
    ),
    () => ({}),
  );
  divergences.push(...runtimeWrappers.divergences);

  divergences.push(
    ...compareKeyed(
      "skipped-function",
      mapOf(
        authority.skippedFunctions,
        ([kind]) => kind,
        ([, count]) => String(count),
      ),
      mapOf(
        shadow.skippedFunctions,
        ([kind]) => kind,
        ([, count]) => String(count),
      ),
      () => ({}),
    ).divergences,
  );

  divergences.push(
    ...compareKeyed(
      "uncarried-contract",
      mapOf(
        authority.uncarriedContracts,
        (line) => line,
        () => "present",
      ),
      mapOf(
        shadow.uncarriedContracts,
        (line) => line,
        () => "present",
      ),
      () => ({}),
    ).divergences,
  );

  // --- the decision -------------------------------------------------------
  if (authority.wouldPass !== shadow.wouldPass) {
    divergences.push(
      divergence({
        category: "ci-decision",
        direction: shadow.wouldPass ? "shadow-less-authority" : "shadow-more-authority",
        risk: "high",
        authorityValue: `wouldPass=${authority.wouldPass}`,
        shadowValue: `wouldPass=${shadow.wouldPass}`,
      }),
    );
  }

  for (const error of input.errors ?? []) {
    divergences.push(
      divergence({
        category: "backend-error",
        direction: "value-mismatch",
        risk: "high",
        authorityValue: error.backend === "authority" ? error.message : null,
        shadowValue: error.backend === "shadow" ? error.message : null,
      }),
    );
  }

  const sorted = divergences.toSorted(
    (a, b) =>
      Number(b.risk === "high") - Number(a.risk === "high") ||
      byString(a.category, b.category) ||
      byString(a.symbol ?? "", b.symbol ?? "") ||
      byString(a.location ?? "", b.location ?? "") ||
      byString(a.authorityValue ?? "", b.authorityValue ?? "") ||
      byString(a.shadowValue ?? "", b.shadowValue ?? ""),
  );

  return {
    schema: "ambit-shadow-report/1",
    root: input.root,
    authorityBackend: authority.backend,
    shadowBackend: shadow.backend,
    notPorted: input.notPorted,
    errors: input.errors ?? [],
    timings: {
      authorityMs: authority.durationMs,
      shadowMs: shadow.durationMs,
      ratio: authority.durationMs === 0 ? 0 : shadow.durationMs / authority.durationMs,
    },
    parity: {
      functions: functions.count,
      calleeResolution: calleeResolution.count,
      callEdges: callEdges.count,
      unresolvedClassification: unresolvedClassification.count,
      directEffects: directEffects.count,
      propagatedEffects: propagatedEffects.count,
      capabilities: capabilities.count,
      authority: parity(authorityAgreed, authorityDisagreed, 0, 0),
      diagnostics: diagnostics.count,
      runtimeWrappers: runtimeWrappers.count,
    },
    authorityDiff: { increases, decreases, unknownGained, unknownLost },
    decision: {
      authorityWouldPass: authority.wouldPass,
      shadowWouldPass: shadow.wouldPass,
      agree: authority.wouldPass === shadow.wouldPass,
    },
    unknownRate: {
      authority: authority.coverage.functionUnknownRate,
      shadow: shadow.coverage.functionUnknownRate,
      delta: shadow.coverage.functionUnknownRate - authority.coverage.functionUnknownRate,
    },
    highRiskCount: sorted.filter((d) => d.risk === "high").length,
    divergences: sorted,
  };
}

function renderRef(ref: AuthorityRef): string {
  return `${ref.kind}:${ref.name}`;
}
