/**
 * Turning one backend's run into facts two backends can be compared on.
 *
 * The comparison is of **Ambit's semantics**, never of two compilers' ASTs: a
 * `ts.Node` and a native `RemoteNode` have nothing in common to compare, and
 * agreeing on them would prove nothing about what `ambit check` reports. So
 * every fact here is keyed on something the analysis already promises is
 * compiler-independent — a `SymbolId` (a relative file path and a declaration
 * path) and a `SourceLocation` (1-based, relative to the checked root) — and
 * every set is sorted, so two runs over the same tree produce identical facts
 * and a divergence is never an ordering artifact.
 *
 * Nothing here imports a compiler. It is pure over the analysis output, which
 * is what lets `test/shadow.compare.test.ts` exercise it without the native
 * engine installed.
 */

import type { Analysis } from "../../src/cli/analyze.ts";
import type {
  AuthorityRecord,
  Call,
  Diagnostic,
  ExtractedProject,
  FunctionSummary,
  SkippedFunctionKind,
  SourceLocation,
  SymbolId,
} from "../../src/core/index.ts";

/** A location as one sortable token: `file:line:col-endLine:endCol`. */
export function locationKey(location: SourceLocation): string {
  return `${location.file}:${location.line}:${location.col}-${location.endLine}:${location.endCol}`;
}

/** What one backend said about one function, in comparable form. */
export interface FunctionFacts {
  readonly symbol: SymbolId;
  readonly location: string;
  readonly declarationStart: string;
  readonly jsDocRange?: string;
  readonly jsDocTags: readonly string[];
  readonly flags: readonly string[];
  readonly bodyCount: number;
}

/** What one backend said about one call site. */
export interface CallFacts {
  readonly owner: SymbolId;
  readonly location: string;
  /** Ordinal among sites sharing an owner and a location, so two calls on one line stay distinct. */
  readonly ordinal: number;
  readonly resolvedCallee?: SymbolId;
  readonly calleeQualifiedName?: string;
  readonly pureBuiltinName?: string;
  readonly unresolvedReason?: string;
  readonly inlinedCallee?: true;
  readonly callbackByReference?: true;
  readonly callbackTargets?: readonly SymbolId[];
  readonly mutation?: string;
  readonly constructedWithoutArguments?: true;
  readonly literalArguments?: readonly string[];
}

/** What the *summarized* call became — Ambit's classification, not the backend's raw site. */
export interface SummaryCallFacts {
  readonly owner: SymbolId;
  readonly location: string;
  readonly ordinal: number;
  readonly kind: string;
  readonly effects: readonly string[];
  readonly capabilities: readonly string[];
  readonly reason?: string;
  readonly operation?: string;
}

export interface ShadowFacts {
  readonly backend: { readonly name: string; readonly version: string };
  readonly durationMs: number;
  readonly functions: readonly FunctionFacts[];
  readonly calls: readonly CallFacts[];
  readonly summaryCalls: readonly SummaryCallFacts[];
  readonly callEdges: readonly string[];
  readonly skippedFunctions: readonly (readonly [SkippedFunctionKind, number])[];
  readonly uncarriedContracts: readonly string[];
  readonly runtimeWrappers: readonly string[];
  readonly diagnostics: readonly string[];
  readonly authority: readonly AuthorityRecord[];
  readonly coverage: {
    readonly functionsExtracted: number;
    readonly functionUnknownRate: number;
    readonly callSitesTotal: number;
    readonly callSitesUnresolved: number;
    readonly unresolvedByReason: readonly (readonly [string, number])[];
  };
  /** What `ambit check` would exit with: a run holding an `error` diagnostic fails. */
  readonly wouldPass: boolean;
}

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ordinals for sites that share an owner and a location, assigned in source order. */
function withOrdinals<T extends { owner: SymbolId; location: string }>(
  entries: readonly Omit<T, "ordinal">[],
): readonly T[] {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const key = `${entry.owner} ${entry.location}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return { ...entry, ordinal } as unknown as T;
  });
}

export function extractionFacts(project: ExtractedProject): {
  readonly functions: readonly FunctionFacts[];
  readonly calls: readonly CallFacts[];
  readonly callEdges: readonly string[];
  readonly skippedFunctions: readonly (readonly [SkippedFunctionKind, number])[];
  readonly uncarriedContracts: readonly string[];
  readonly runtimeWrappers: readonly string[];
} {
  const functions: FunctionFacts[] = [];
  const rawCalls: Omit<CallFacts, "ordinal">[] = [];
  const callEdges = new Set<string>();
  const runtimeWrappers: string[] = [];

  for (const file of project.files) {
    for (const fn of file.functions) {
      const flags: string[] = [];
      if (fn.implicitConstructor) flags.push("implicitConstructor");
      if (fn.configOnly) flags.push("configOnly");
      if (fn.undeclarable) flags.push("undeclarable");
      functions.push({
        symbol: fn.id,
        location: locationKey(fn.location),
        declarationStart: locationKey(fn.declarationStart),
        ...(fn.jsDocRange ? { jsDocRange: locationKey(fn.jsDocRange) } : {}),
        jsDocTags: [...(fn.jsDoc?.tags ?? new Map<string, string>())]
          .map(([tag, raw]) => `${tag}=${raw}`)
          .toSorted(byString),
        flags,
        bodyCount: fn.bodies?.length ?? 1,
      });
      for (const call of fn.calls) {
        rawCalls.push({
          owner: fn.id,
          location: locationKey(call.location),
          ...(call.resolvedCallee ? { resolvedCallee: call.resolvedCallee } : {}),
          ...(call.calleeQualifiedName ? { calleeQualifiedName: call.calleeQualifiedName } : {}),
          ...(call.pureBuiltinName ? { pureBuiltinName: call.pureBuiltinName } : {}),
          ...(call.unresolvedReason ? { unresolvedReason: call.unresolvedReason } : {}),
          ...(call.inlinedCallee ? { inlinedCallee: true as const } : {}),
          ...(call.callbackByReference ? { callbackByReference: true as const } : {}),
          ...(call.callbackTargets
            ? { callbackTargets: [...call.callbackTargets].toSorted(byString) }
            : {}),
          ...(call.mutation
            ? {
                mutation: [
                  call.mutation.escaping ? "escaping" : "local",
                  call.mutation.qualifiedName ?? "",
                  call.mutation.unknownCallback ? "unknownCallback" : "",
                ].join("|"),
              }
            : {}),
          ...(call.constructedWithoutArguments
            ? { constructedWithoutArguments: true as const }
            : {}),
          ...(call.literalArguments
            ? {
                literalArguments: call.literalArguments.map((argument) =>
                  argument === undefined
                    ? "-"
                    : JSON.stringify({
                        text: argument.text,
                        complete: argument.complete,
                        properties: argument.properties
                          ? [...argument.properties].toSorted((a, b) => byString(a[0], b[0]))
                          : undefined,
                      }),
                ),
              }
            : {}),
        });
        if (call.resolvedCallee) callEdges.add(`${fn.id} calls ${call.resolvedCallee}`);
        for (const target of call.callbackTargets ?? []) {
          callEdges.add(`${fn.id} hands ${target}`);
        }
      }
    }
    for (const wrapper of file.runtimeWrappers) {
      runtimeWrappers.push(
        [
          locationKey(wrapper.location),
          wrapper.wrapper,
          wrapper.capabilities
            ? `caps=[${[...wrapper.capabilities].toSorted(byString).join(",")}]`
            : "caps=-",
          wrapper.budget ? `budget=${JSON.stringify(wrapper.budget)}` : "budget=-",
          wrapper.handler ?? `unmatched=${wrapper.unmatchedReason ?? "?"}`,
        ].join(" "),
      );
    }
  }

  return {
    functions: functions.toSorted((a, b) => byString(a.symbol, b.symbol)),
    calls: withOrdinals<CallFacts>(rawCalls),
    callEdges: [...callEdges].toSorted(byString),
    skippedFunctions: [...project.skippedFunctions].toSorted((a, b) => byString(a[0], b[0])),
    uncarriedContracts: project.uncarriedContracts
      .map(
        (c) =>
          `${locationKey(c.location)} ${c.kind} @${c.tag} ${c.raw}${c.configKey ? ` (${c.configKey})` : ""}`,
      )
      .toSorted(byString),
    runtimeWrappers: runtimeWrappers.toSorted(byString),
  };
}

/** The classification `summarize.ts` gave each call — Ambit's direct effects and capabilities. */
export function summaryCallFacts(
  summaries: readonly FunctionSummary[],
): readonly SummaryCallFacts[] {
  const raw: Omit<SummaryCallFacts, "ordinal">[] = [];
  for (const summary of summaries) {
    for (const call of summary.calls) raw.push(oneSummaryCall(summary.id, call));
  }
  return withOrdinals<SummaryCallFacts>(raw);
}

function oneSummaryCall(owner: SymbolId, call: Call): Omit<SummaryCallFacts, "ordinal"> {
  // Read structurally rather than by narrowing on every kind: the union grows,
  // and a shadow comparison that silently stopped reading a new field would
  // report parity it did not measure.
  const fields = call as Call & {
    readonly effects?: readonly string[];
    readonly capabilities?: readonly string[];
    readonly reason?: string;
    readonly operation?: string;
    readonly qualifiedName?: string;
  };
  const operation = fields.operation ?? fields.qualifiedName;
  return {
    owner,
    location: locationKey(call.location),
    kind: call.kind,
    effects: [...(fields.effects ?? [])].toSorted(byString),
    capabilities: [...(fields.capabilities ?? [])].toSorted(byString),
    ...(fields.reason ? { reason: fields.reason } : {}),
    ...(operation ? { operation } : {}),
  };
}

/** One diagnostic as a comparable line. The message is included: it is what a reader acts on. */
export function diagnosticFacts(diagnostics: readonly Diagnostic[]): readonly string[] {
  return diagnostics
    .map((d) => `${d.id} ${d.severity} ${locationKey(d.location)} ${d.message}`)
    .toSorted(byString);
}

export function buildFacts(input: {
  readonly backend: { readonly name: string; readonly version: string };
  readonly durationMs: number;
  readonly project: ExtractedProject;
  readonly summaries: readonly FunctionSummary[];
  readonly analysis: Analysis;
}): ShadowFacts {
  const extraction = extractionFacts(input.project);
  const { coverage } = input.analysis;
  return {
    backend: input.backend,
    durationMs: input.durationMs,
    ...extraction,
    summaryCalls: summaryCallFacts(input.summaries),
    diagnostics: diagnosticFacts(input.analysis.diagnostics),
    authority: [...input.analysis.authority].toSorted((a, b) => byString(a.symbol, b.symbol)),
    coverage: {
      functionsExtracted: coverage.functionsExtracted,
      functionUnknownRate: coverage.functionUnknownRate,
      callSitesTotal: coverage.callSitesTotal,
      callSitesUnresolved: coverage.callSitesUnresolved,
      unresolvedByReason: [...coverage.unresolvedByReason].toSorted((a, b) => byString(a[0], b[0])),
    },
    wouldPass: !input.analysis.diagnostics.some((d) => d.severity === "error"),
  };
}
