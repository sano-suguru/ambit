import type {
  FunctionSummary,
  SkippedFunctionKind,
  SymbolId,
  UnresolvedReason,
} from "../core/index.ts";
import type { PropagatedFunction } from "./propagate.ts";

/** How many top unresolved-call names to surface — the "what to stub next" signal. */
const TOP_UNRESOLVED_NAMES = 10;

export interface CoverageInput {
  readonly filesAnalyzed: number;
  readonly skippedFunctions: ReadonlyMap<SkippedFunctionKind, number>;
  readonly summaries: readonly FunctionSummary[];
  readonly state: ReadonlyMap<SymbolId, PropagatedFunction>;
}

export interface CoverageReport {
  readonly filesAnalyzed: number;
  readonly functionsExtracted: number;
  readonly functionsDeclared: number;
  /**
   * How {@link functionsDeclared} splits by where the declaration was written
   * (DESIGN.md §4.1「コード外宣言」). Reported apart because the two are not
   * interchangeable evidence: a JSDoc contract travels with the code and
   * survives the package being removed (P5), while a config contract is a
   * statement *about* code that was not touched — often third-party or
   * generated. A coverage figure that merged them would hide how much of the
   * declared surface lives outside the source it describes.
   */
  readonly functionsDeclaredByJsDoc: number;
  readonly functionsDeclaredByConfig: number;
  /**
   * Functions whose body is excluded from static analysis by `@boundary`
   * (DESIGN.md §4.6). Counted apart from everything else because §4.3
   * requires it: 「境界への移行は解析成功と区別して集計する」. A boundary is a
   * declared hole, and a coverage figure that folded it into the resolved
   * count would report the hole as progress.
   */
  readonly functionsBoundary: number;
  /** Functions marked `@entrypoint`, and how many of those declare no `@capabilities`. */
  readonly functionsEntrypoint: number;
  readonly entrypointsWithoutCapabilities: number;
  readonly functionsSkipped: number;
  readonly skippedByKind: ReadonlyMap<SkippedFunctionKind, number>;
  /**
   * The primary KPI (DESIGN.md §10, "the plan's note on measuring extraction
   * coverage before trusting it"): the fraction of *all* extracted functions
   * — declared or not — whose propagated effect set carries `unknown`. This
   * is what a user actually cares about ("can Ambit say anything definite
   * about this function?"), not the raw call-site resolution rate below,
   * which is an internal diagnostic, not the target itself.
   */
  readonly functionUnknownRate: number;
  /**
   * Boundary functions as a fraction of extracted functions, reported next to
   * {@link functionUnknownRate} because tagging a function `@boundary` moves
   * it out of the unknown numerator while leaving it in the denominator.
   * Without this figure beside it, declaring boundaries would read as an
   * improving KPI (DESIGN.md §4.3: 「境界への移行は解析成功と区別して集計する」).
   * The two rates together are the fraction of functions whose contract is
   * not backed by a verified body.
   */
  readonly functionBoundaryRate: number;
  readonly callSitesTotal: number;
  readonly callSitesResolved: number;
  readonly callSitesStub: number;
  readonly callSitesPure: number;
  /**
   * In-place mutation sites (DESIGN.md §4.2, 「ローカル変異と `pure`」).
   * Counted apart from `callSitesPure` and `callSitesStub`: a local mutation
   * carries no effect but is not the same evidence as a call proven pure, and
   * an escaping one is a `state_write` that no stub table produced.
   */
  readonly callSitesMutation: number;
  readonly callSitesUnresolved: number;
  readonly unresolvedByReason: ReadonlyMap<UnresolvedReason, number>;
  readonly topUnresolvedNames: readonly { readonly name: string; readonly count: number }[];
}

export function computeCoverage(input: CoverageInput): CoverageReport {
  const { filesAnalyzed, skippedFunctions, summaries, state } = input;

  const functionsExtracted = summaries.length;
  const declaredSummaries = summaries.filter((s) => s.declared.kind === "declared");
  const functionsDeclared = declaredSummaries.length;
  const functionsDeclaredByConfig = declaredSummaries.filter(
    (s) => s.declaredBy === "config",
  ).length;
  const functionsDeclaredByJsDoc = functionsDeclared - functionsDeclaredByConfig;
  const functionsBoundary = summaries.filter((s) => s.boundary.kind === "declared").length;
  const entrypoints = summaries.filter((s) => s.entrypoint);
  const entrypointsWithoutCapabilities = entrypoints.filter(
    (s) => s.capabilities.kind !== "declared",
  ).length;

  let unknownCount = 0;
  for (const summary of summaries) {
    if (state.get(summary.id)?.observed.unknown) unknownCount++;
  }
  const functionUnknownRate = functionsExtracted === 0 ? 0 : unknownCount / functionsExtracted;
  const functionBoundaryRate =
    functionsExtracted === 0 ? 0 : functionsBoundary / functionsExtracted;

  let callSitesResolved = 0;
  let callSitesStub = 0;
  let callSitesPure = 0;
  let callSitesMutation = 0;
  let callSitesUnresolved = 0;
  const unresolvedByReason = new Map<UnresolvedReason, number>();
  const nameFrequency = new Map<string, number>();

  for (const summary of summaries) {
    // A boundary's body is excluded from propagation, so its call sites say
    // nothing about how well the analysis resolves things. Counting them
    // would make a declared hole look like unresolved analysis (and pad
    // `topUnresolvedNames`, the "what to stub next" signal, with names no
    // stub would help).
    if (summary.boundary.kind === "declared") continue;
    for (const call of summary.calls) {
      if (call.kind === "resolved") {
        callSitesResolved++;
      } else if (call.kind === "stub") {
        callSitesStub++;
      } else if (call.kind === "known-pure") {
        callSitesPure++;
      } else if (call.kind === "mutation") {
        callSitesMutation++;
      } else {
        callSitesUnresolved++;
        unresolvedByReason.set(call.reason, (unresolvedByReason.get(call.reason) ?? 0) + 1);
        if (call.qualifiedName) {
          nameFrequency.set(call.qualifiedName, (nameFrequency.get(call.qualifiedName) ?? 0) + 1);
        }
      }
    }
  }

  const topUnresolvedNames = [...nameFrequency.entries()]
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
    .slice(0, TOP_UNRESOLVED_NAMES)
    .map(([name, count]) => ({ name, count }));

  const functionsSkipped = [...skippedFunctions.values()].reduce((total, n) => total + n, 0);

  return {
    filesAnalyzed,
    functionsExtracted,
    functionsDeclared,
    functionsDeclaredByJsDoc,
    functionsDeclaredByConfig,
    functionsBoundary,
    functionsEntrypoint: entrypoints.length,
    entrypointsWithoutCapabilities,
    functionsSkipped,
    skippedByKind: skippedFunctions,
    functionUnknownRate,
    functionBoundaryRate,
    callSitesTotal:
      callSitesResolved + callSitesStub + callSitesPure + callSitesMutation + callSitesUnresolved,
    callSitesResolved,
    callSitesStub,
    callSitesPure,
    callSitesMutation,
    callSitesUnresolved,
    unresolvedByReason,
    topUnresolvedNames,
  };
}
