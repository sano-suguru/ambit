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

/**
 * What a compared value asserts, reduced to two sets so that "the shadow
 * backend reported less" can be decided from the values themselves.
 *
 * This is the half of the report that must never depend on
 * {@link KNOWN_DIVERGENCES}. Classification is a triage aid and a heuristic;
 * direction and risk are the signal, and a rule written to explain a known gap
 * must not be able to downgrade a genuine regression that happens to look like
 * it. So the two are computed in that order and from different inputs: risk
 * from the signals below, classification afterwards and only for the note it
 * carries.
 *
 * - `authority` — every token whose presence means authority was *reported*:
 *   an effect, a capability, a stub match, a wrapper budget, an error
 *   diagnostic. Losing one is DESIGN.md §3.4's forbidden direction.
 * - `unknown` — every token whose presence means the analysis *admitted it did
 *   not know*: an `unknown` flag, an unresolved reason, an opaque callback.
 *   Losing one is the same failure wearing a different hat — a site that
 *   silently stops being `unknown` is a check that passes for the wrong
 *   reason.
 */
export interface Signal {
  readonly authority: readonly string[];
  readonly unknown: readonly string[];
}

/** A rendered value plus, where one can be derived, its {@link Signal}. */
interface ComparedValue {
  readonly rendered: string;
  readonly signal?: Signal;
}

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

/**
 * Empty, and the emptiness is the current finding rather than a placeholder.
 *
 * The one rule that lived here matched any `call-edge` whose authoritative
 * value read `present` — every `shadow-missing` edge, with no condition on the
 * shadow side at all. `classify` consults `declinedBySymbol` first, so a
 * missing edge with a declined site behind it never reached this rule; the
 * only divergence it could still catch was a missing edge with *nothing*
 * behind it, which is a genuine one, and it labelled that `not-yet-ported`.
 * It was written when the call-edge dimension had no structured code to
 * consult and it outlived that.
 *
 * A rule added here is a claim about *why* two compilers differ, so it carries
 * the evidence line that justifies it — never a guess to make a number look
 * better, and never a condition so wide that a real disagreement satisfies it.
 */
export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [];

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

/**
 * Codes the shadow backend itself reported, keyed by location — set once per
 * comparison so {@link classify} can read them. A module-level binding rather
 * than a parameter threaded through nine call sites, because `compareFacts` is
 * one synchronous pass and the alternative is nine signatures carrying a field
 * eight of them ignore.
 */
let declinedReasons: ReadonlyMap<string, string> = new Map();

/**
 * The same codes reached by owning symbol.
 *
 * A divergence in a propagated dimension — authority, capabilities, the
 * propagated effect set — has a symbol and no location, because it is the
 * *function's* result rather than one call's. The gap that produced it is
 * still a call site inside that function, so the codes are indexed both ways
 * and the symbol lookup answers the propagated half. Fifteen divergences on
 * `test/fixtures/backend-smoke` that had to read `unclassified` are exactly
 * this: one unported call site, seen from four dimensions up.
 */
let declinedBySymbol: ReadonlyMap<SymbolId, readonly string[]> = new Map();

function indexDeclinedBySymbol(
  calls: readonly CallFacts[],
  byLocation: ReadonlyMap<string, string>,
): ReadonlyMap<SymbolId, readonly string[]> {
  const index = new Map<SymbolId, string[]>();
  for (const call of calls) {
    const code = byLocation.get(call.location);
    if (code === undefined) continue;
    const codes = index.get(call.owner) ?? [];
    if (!codes.includes(code)) codes.push(code);
    index.set(call.owner, codes);
  }
  return index;
}

function classify(
  category: DivergenceCategory,
  authorityValue: string | null,
  shadowValue: string | null,
  location: string | undefined,
  symbol: SymbolId | undefined,
): { classification: DivergenceClassification; note?: string } {
  // Structured first. A code here was written by the backend at the point it
  // declined, so it says what the gap *is* rather than what the rendered pair
  // happens to look like.
  const code = location === undefined ? undefined : declinedReasons.get(location);
  if (code !== undefined) {
    return {
      classification: "not-yet-ported",
      note: `the shadow backend reported \`${code}\` at this site (NOT_PORTED)`,
    };
  }
  // Only where there is no location of its own. A call-site divergence has
  // both a symbol and a location, and consulting the symbol index for one of
  // those would hand `not-yet-ported` to every call site inside a function
  // that happens to contain one declined site — which is precisely the failure
  // the substring classifier had, rebuilt out of structured data. Measured:
  // eight genuine `shadow-less-authority` disagreements on the corpus
  // (`mutation=local|Set.add|` against `builtin=Set.add`) read as accounted
  // for when they are not.
  const codes =
    location !== undefined || symbol === undefined ? undefined : declinedBySymbol.get(symbol);
  if (codes !== undefined && codes.length > 0) {
    return {
      classification: "not-yet-ported",
      note: `propagated from a call site in this function the shadow backend declined: ${codes.join(", ")} (NOT_PORTED)`,
    };
  }
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
    input.location,
    input.symbol,
  );
  const risk =
    input.risk ??
    (input.direction === "shadow-less-authority" || input.direction === "shadow-less-unknown"
      ? "high"
      : "normal");
  return { ...input, risk, classification, ...(note ? { note } : {}) };
}

/**
 * Which way a pair of values differs, read off the values and nothing else.
 *
 * Losing authority is checked before losing an `unknown`, and both before
 * either gain, so a pair that both loses and gains reports the unsafe half.
 * A pair with no signals, or with equal ones, is a `value-mismatch` — a real
 * difference whose direction this cannot decide, which is not the same as a
 * safe one and is not reported as one.
 */
function directionOf(
  authority: Signal | undefined,
  shadow: Signal | undefined,
): DivergenceDirection {
  if (!authority || !shadow) return "value-mismatch";
  const missing = (from: readonly string[], into: readonly string[]): boolean =>
    from.some((token) => !into.includes(token));
  if (missing(authority.authority, shadow.authority)) return "shadow-less-authority";
  if (missing(authority.unknown, shadow.unknown)) return "shadow-less-unknown";
  if (missing(shadow.authority, authority.authority)) return "shadow-more-authority";
  if (missing(shadow.unknown, authority.unknown)) return "shadow-more-unknown";
  return "value-mismatch";
}

/** Compare two keyed sets of rendered values, one divergence per key that differs. */
function compareKeyed(
  category: DivergenceCategory,
  authority: ReadonlyMap<string, ComparedValue>,
  shadow: ReadonlyMap<string, ComparedValue>,
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
          authorityValue: authorityValue.rendered,
          shadowValue: null,
        }),
      );
    } else if (shadowValue.rendered === authorityValue.rendered) {
      agreed++;
    } else {
      disagreed++;
      divergences.push(
        divergence({
          category,
          direction: directionOf(authorityValue.signal, shadowValue.signal),
          ...describe(key),
          authorityValue: authorityValue.rendered,
          shadowValue: shadowValue.rendered,
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
        shadowValue: shadowValue.rendered,
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

/**
 * A call site's signal.
 *
 * A resolved callee, a qualified name, a proven-pure builtin and a recorded
 * mutation are all authority the site reported; an unresolved reason and an
 * opaque callback are admissions that it did not know. Losing either is the
 * unsafe direction, which is why both are read off the facts rather than off
 * the rendered line.
 */
function callSignal(call: CallFacts): Signal {
  const authority: string[] = [];
  if (call.resolvedCallee) authority.push(`resolved:${call.resolvedCallee}`);
  if (call.calleeQualifiedName) authority.push(`name:${call.calleeQualifiedName}`);
  if (call.pureBuiltinName) authority.push(`builtin:${call.pureBuiltinName}`);
  if (call.inlinedCallee) authority.push("inlined");
  const unknown: string[] = [];
  if (call.unresolvedReason) unknown.push(`reason:${call.unresolvedReason}`);
  if (call.callbackByReference) unknown.push("callbackByReference");
  // A mutation's parts belong on opposite sides. What was mutated and whether
  // it escapes is reported authority; `unknownCallback` is the site admitting
  // that a callable it was handed is opaque (DESIGN.md §4.2 rule 4). Folding
  // the rendered triple into one token made the conservative side — the one
  // that adds `unknownCallback` — read as *losing* authority, which inverts
  // the very direction this is here to get right.
  if (call.mutation) {
    const [escaping = "", qualifiedName = "", unknownCallback = ""] = call.mutation.split("|");
    authority.push(`mutation:${escaping}|${qualifiedName}`);
    if (unknownCallback) unknown.push(`mutation:${unknownCallback}`);
  }
  return { authority, unknown };
}

/**
 * A summarized call's signal: every effect and capability it reported, plus
 * the stub match that produced them, against the `unknown` it admitted.
 */
function summaryCallSignal(call: SummaryCallFacts): Signal {
  const authority = [
    ...call.effects.map((effect) => `effect:${effect}`),
    ...call.capabilities.map((capability) => `capability:${capability}`),
    ...(call.kind === "unresolved" ? [] : [`kind:${call.kind}`]),
    ...(call.operation ? [`operation:${call.operation}`] : []),
  ];
  const unknown = call.kind === "unresolved" ? [`reason:${call.reason ?? "-"}`] : [];
  return { authority, unknown };
}

function effectsSignal(record: AuthorityRecord): Signal {
  return {
    authority: [...record.effects.observed].map((effect) => `effect:${effect}`),
    unknown: record.effects.unknown ? ["effects-unknown"] : [],
  };
}

function capabilitiesSignal(record: AuthorityRecord): Signal {
  return {
    authority: [...record.capabilities.required].map((capability) => `capability:${capability}`),
    unknown: record.capabilities.unknown ? ["capabilities-unknown"] : [],
  };
}

/**
 * A runtime wrapper's signal. A wrapper's capabilities and its **budget** are
 * both enforcement: a budget that reads as absent is what silences AMB-E011,
 * which is how four error diagnostics went missing on
 * `test/fixtures/wrappers` while the pair still read as an ordinary value
 * mismatch.
 */
function wrapperSignal(rest: readonly string[]): Signal {
  return {
    authority: rest.filter((field) => field !== "caps=-" && field !== "budget=-"),
    unknown: rest.filter((field) => field.startsWith("unmatched=")),
  };
}

/** A diagnostic's signal: its severity is the enforcement it carries. */
function diagnosticSignal(rest: readonly string[]): Signal {
  return { authority: rest.slice(0, 1), unknown: [] };
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

/**
 * `id` and location out of `${id} ${severity} ${location} ${message}` — a
 * diagnostic's identity. Severity and message are content: if they differ, the
 * pair is a `value-mismatch` that names the site, not a missing entry.
 */
const DIAGNOSTIC_KEY_FIELDS: readonly number[] = [0, 2];

/** Location and wrapper name out of a runtime-wrapper line; capabilities, budget and handler are content. */
const WRAPPER_KEY_FIELDS: readonly number[] = [0, 1];

/** Split each space-joined line into (identity fields, everything else). */
function keyedLines(
  lines: readonly string[],
  keyFields: readonly number[],
  signal?: (rest: readonly string[]) => Signal,
): ReadonlyMap<string, ComparedValue> {
  const map = new Map<string, ComparedValue>();
  for (const line of lines) {
    const fields = line.split(" ");
    const key = keyFields.map((index) => fields[index] ?? "").join(" ");
    const rest = fields.filter((_, index) => !keyFields.includes(index));
    // A duplicate key would silently drop one of the two. Numbering makes the
    // pair comparable instead, the same way call sites are keyed by ordinal.
    let unique = key;
    for (let n = 2; map.has(unique); n++) unique = `${key} #${n}`;
    map.set(unique, {
      rendered: rest.join(" "),
      ...(signal ? { signal: signal(rest) } : {}),
    });
  }
  return map;
}

/** The identity half of a line key, reported as the divergence's location. */
function describeLineKey(key: string): { symbol?: SymbolId; location?: string } {
  return { location: key };
}

function mapOf<T>(
  items: readonly T[],
  key: (item: T) => string,
  value: (item: T) => string,
  signal?: (item: T) => Signal,
): ReadonlyMap<string, ComparedValue> {
  const map = new Map<string, ComparedValue>();
  for (const item of items) {
    map.set(key(item), { rendered: value(item), ...(signal ? { signal: signal(item) } : {}) });
  }
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
  /**
   * `location -> NOT_PORTED code`, as the shadow backend reported them. What
   * makes classification read data instead of parsing rendered text; absent
   * for a self-check, where both sides are the adopted backend and nothing
   * declines.
   */
  readonly shadowDeclined?: ReadonlyMap<string, string>;
  readonly errors?: readonly {
    readonly backend: string;
    readonly phase: string;
    readonly message: string;
  }[];
}

export function compareFacts(input: CompareInput): ShadowReport {
  const { authority, shadow } = input;
  declinedReasons = input.shadowDeclined ?? new Map();
  declinedBySymbol = indexDeclinedBySymbol(shadow.calls, declinedReasons);
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
    mapOf(authority.calls, callKey, calleeResolutionOf, callSignal),
    mapOf(shadow.calls, callKey, calleeResolutionOf, callSignal),
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
    mapOf(authority.calls, callKey, unresolvedClassificationOf, callSignal),
    mapOf(shadow.calls, callKey, unresolvedClassificationOf, callSignal),
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
      summaryCallSignal,
    ),
    mapOf(
      shadow.summaryCalls,
      callKey,
      (call) =>
        `kind=${call.kind} effects=[${call.effects.join(",")}] capabilities=[${call.capabilities.join(",")}] reason=${call.reason ?? "-"} operation=${call.operation ?? "-"}`,
      summaryCallSignal,
    ),
    describeCallKey,
  );
  divergences.push(...directEffects.divergences);

  // --- propagated effects / capabilities ----------------------------------
  const propagatedEffects = compareKeyed(
    "propagated-effect",
    mapOf(authority.authority, (record) => record.symbol, authorityEffectsOf, effectsSignal),
    mapOf(shadow.authority, (record) => record.symbol, authorityEffectsOf, effectsSignal),
    (key) => ({ symbol: key as SymbolId }),
  );
  divergences.push(...propagatedEffects.divergences);

  const capabilities = compareKeyed(
    "capability",
    mapOf(
      authority.authority,
      (record) => record.symbol,
      authorityCapabilitiesOf,
      capabilitiesSignal,
    ),
    mapOf(shadow.authority, (record) => record.symbol, authorityCapabilitiesOf, capabilitiesSignal),
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
  // Keyed on identity, valued on content. Keying a diagnostic or a wrapper on
  // its *whole* rendered line made every difference read as one entry missing
  // and one extra, with `present` on both sides and no symbol or location to
  // read — 16 such pairs on `test/fixtures/wrappers` said nothing about what
  // differed. Splitting the line puts the disagreement in the value, where a
  // reader can see it, and makes `shadow-missing` mean what it says: the
  // shadow backend produced no diagnostic there at all.
  const diagnostics = compareKeyed(
    "diagnostic",
    keyedLines(authority.diagnostics, DIAGNOSTIC_KEY_FIELDS, diagnosticSignal),
    keyedLines(shadow.diagnostics, DIAGNOSTIC_KEY_FIELDS, diagnosticSignal),
    describeLineKey,
  );
  divergences.push(...diagnostics.divergences);

  const runtimeWrappers = compareKeyed(
    "runtime-wrapper",
    keyedLines(authority.runtimeWrappers, WRAPPER_KEY_FIELDS, wrapperSignal),
    keyedLines(shadow.runtimeWrappers, WRAPPER_KEY_FIELDS, wrapperSignal),
    describeLineKey,
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
