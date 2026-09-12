import type {
  AuthorityRecord,
  Diagnostic,
  DiagnosticEngine,
  FunctionSummary,
  RuntimeWrapper,
  SkippedFunctionKind,
  SymbolId,
  UncarriedContract,
} from "../core/index.ts";
import { buildAuthorityRecords } from "./authority.ts";
import type { ResolvedConfig } from "./config.ts";
import { type CoverageReport, computeCoverage } from "./coverage.ts";
import {
  diagnose,
  diagnoseContractDivergence,
  diagnoseRuntimeWrappers,
  diagnoseUncarriedContracts,
  diagnoseUnmatchedConfigKeys,
  sortDiagnostics,
} from "./diagnose.ts";
import { type ConfigTarget, proposeContracts } from "./init.ts";
import type { PropagatedFunction } from "./propagate.ts";

/** One run of the analysis over one directory. */
export interface AnalysisResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Per-function authority (DESIGN.md §5.1), the input `ambit diff` compares. */
  readonly authority: readonly AuthorityRecord[];
  readonly coverage: CoverageReport;
}

/**
 * Everything the reporting phase reads. Deliberately not an `ExtractedProject`
 * plus a `ResolvedConfig`: the resident path (DESIGN.md §6.2) holds the same
 * facts per file and re-sums them, and passing the already-summed values is
 * what lets the two paths share this code instead of each composing the
 * diagnostics in its own order.
 */
export interface ReportInput {
  readonly state: ReadonlyMap<SymbolId, PropagatedFunction>;
  readonly summaries: readonly FunctionSummary[];
  readonly uncarriedContracts: readonly UncarriedContract[];
  readonly runtimeWrappers: readonly RuntimeWrapper[];
  /** Exact `ambit.config.ts` keys that named no extracted symbol (AMB-W006). */
  readonly unmatchedExactKeys: readonly string[];
  readonly filesAnalyzed: number;
  readonly skippedFunctions: ReadonlyMap<SkippedFunctionKind, number>;
  readonly engine: DiagnosticEngine;
  readonly config: ResolvedConfig | undefined;
  readonly strict: boolean;
  /** `ambit init`: report contract proposals instead of violations. */
  readonly propose?: boolean;
  /** `ambit init --config`: where config additions would be written. */
  readonly proposeTarget?: ConfigTarget;
}

/**
 * DESIGN.md §6.2's `report` phase: diagnostics, authority records, coverage.
 *
 * One function, called by the cold path (`analyze`) and by the resident one,
 * because §6.2's equivalence law is over bytes. Two compositions of the same
 * diagnostics would be two orders to keep in step, and the first divergence
 * between them would look like an analysis difference rather than a reporting
 * one.
 */
export function buildReport(input: ReportInput): AnalysisResult {
  const { state, summaries, config, engine } = input;
  const diagnostics = input.propose
    ? proposeContracts(state, engine, input.proposeTarget)
    : applyStrict(
        [
          ...diagnose(state, engine),
          ...diagnoseUncarriedContracts(input.uncarriedContracts, engine),
          ...diagnoseRuntimeWrappers(input.runtimeWrappers, state, engine),
          ...(config ? diagnoseContractDivergence(state, config.displayPath, engine) : []),
          ...(config
            ? diagnoseUnmatchedConfigKeys(
                input.unmatchedExactKeys,
                config.displayPath,
                config.sourceText,
                engine,
              )
            : []),
        ],
        input.strict,
        config,
      );

  return {
    // Sorted here rather than by each caller, so the cold path and the
    // resident one cannot disagree about the order by forgetting to
    // (DESIGN.md §6.2's equivalence law).
    diagnostics: sortDiagnostics(diagnostics),
    authority: buildAuthorityRecords(state),
    coverage: computeCoverage({
      filesAnalyzed: input.filesAnalyzed,
      skippedFunctions: input.skippedFunctions,
      summaries,
      state,
    }),
  };
}

/**
 * The diagnostics `--strict` promotes to errors: the two that say "analysis
 * reached something it could not resolve" (DESIGN.md §4.2 rule 3 — "Ambit's
 * `strict: true` can promote it to an error"). Deliberately not every warning:
 * `--strict` means "an unverified path is not acceptable here", which is a
 * different claim from promoting, say, an entrypoint's missing capability set.
 */
const STRICT_PROMOTED_IDS: ReadonlySet<string> = new Set(["AMB-W001", "AMB-W003"]);

/**
 * `--strict` promotes everywhere; `strict` in `ambit.config.ts` promotes only
 * inside the globs it lists (DESIGN.md §4.3: "`strict` can be set per
 * directory in `ambit.config.ts`. Tighten new code while leaving legacy code
 * at warnings"). The two are a union, so `--strict` on the command line is never
 * narrowed by a config that lists fewer directories.
 *
 * Matched on the diagnostic's own file, which is why the config-level
 * diagnostics (AMB-W005/W006) are unaffected in practice: theirs is the
 * config file, which no `strict` glob names.
 */
function applyStrict(
  diagnostics: readonly Diagnostic[],
  strict: boolean,
  config: ResolvedConfig | undefined,
): readonly Diagnostic[] {
  if (!strict && config === undefined) return diagnostics;
  return diagnostics.map((diagnostic) =>
    STRICT_PROMOTED_IDS.has(diagnostic.id) &&
    (strict || config?.isStrictFile(diagnostic.location.file) === true)
      ? { ...diagnostic, severity: "error" as const }
      : diagnostic,
  );
}
