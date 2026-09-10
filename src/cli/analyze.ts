import type { CoverageReport } from "../checker/coverage.ts";
import {
  buildAuthorityRecords,
  type ConfigTarget,
  computeCoverage,
  diagnose,
  diagnoseContractDivergence,
  diagnoseRuntimeWrappers,
  diagnoseUncarriedContracts,
  diagnoseUnmatchedConfigKeys,
  legacyTsBackend,
  loadConfig,
  propagate,
  proposeContracts,
  type ResolvedConfig,
  resolveConfig,
  summarizeExtractedFiles,
} from "../checker/index.ts";
import type { AuthorityRecord, Diagnostic } from "../core/index.ts";

/** One run of the analysis over one directory. */
export interface Analysis {
  readonly diagnostics: readonly Diagnostic[];
  /** Per-function authority (DESIGN.md §5.1), the input `ambit diff` compares. */
  readonly authority: readonly AuthorityRecord[];
  readonly coverage: CoverageReport;
}

export interface AnalyzeOptions {
  /** `init`: report contract proposals instead of violations. */
  readonly propose?: boolean;
  /** `init --config`: also propose `ambit.config.ts` entries (DESIGN.md §4.1 (a)). */
  readonly proposeConfig?: boolean;
  /** `--strict`: promote the `unknown` warnings to errors (DESIGN.md §4.2 rule 3). */
  readonly strict?: boolean;
}

/**
 * Load the config, extract, summarize, propagate, diagnose and count — the
 * whole single-directory pipeline, in one place.
 *
 * Extracted from `main` because `ambit diff` runs it twice, once per tree,
 * and the two runs must be the same run: a base side that analyzed a
 * directory even slightly differently would report the difference as a change
 * in authority.
 *
 * Throws on any failure. A caller turns that into exit 2 — an analysis that
 * could not run must never be reported as "checked, nothing wrong"
 * (DESIGN.md §3.4).
 *
 * @effects fs_read
 */
export async function analyze(dir: string, options: AnalyzeOptions = {}): Promise<Analysis> {
  // Loaded before extraction so a broken config stops the run before any
  // work is reported (DESIGN.md §3.4): a config that could not be read must
  // never come out as "checked, no violations".
  const loaded = await loadConfig(dir);
  const config: ResolvedConfig | undefined = loaded ? resolveConfig(loaded, dir) : undefined;
  const project = await legacyTsBackend.extractProject(dir);
  // No extracted function anywhere means "nothing analyzable was found"
  // (zero .ts files, or every function-like node was skipped) — that must
  // not read the same as "checked, no violations" (DESIGN.md §3.4). Counted
  // over functions rather than over `files`, because a file can now be
  // pushed for its `withAmbit` wrappers alone.
  const functionsFound = project.files.reduce((total, file) => total + file.functions.length, 0);
  if (functionsFound === 0) {
    throw new Error(`no analyzable functions found under ${dir}`);
  }
  const summaries = summarizeExtractedFiles(project.files, config);
  const state = propagate(summaries);
  const engine = { name: legacyTsBackend.name, version: legacyTsBackend.version };
  const diagnostics = options.propose
    ? proposeContracts(state, engine, options.proposeConfig ? configTarget(config, dir) : undefined)
    : applyStrict(
        [
          ...diagnose(state, engine),
          ...diagnoseUncarriedContracts(project.uncarriedContracts, engine),
          ...diagnoseRuntimeWrappers(
            project.files.flatMap((file) => file.runtimeWrappers),
            state,
            engine,
          ),
          ...(config ? diagnoseContractDivergence(state, config.displayPath, engine) : []),
          ...(config
            ? diagnoseUnmatchedConfigKeys(
                config.unmatchedExactKeys(),
                config.displayPath,
                config.sourceText,
                engine,
              )
            : []),
        ],
        options.strict ?? false,
        config,
      );

  return {
    diagnostics,
    authority: buildAuthorityRecords(state),
    coverage: computeCoverage({
      filesAnalyzed: project.files.length,
      skippedFunctions: project.skippedFunctions,
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

/**
 * Where `ambit init --config` should write, and what is already there — the
 * config file's path and text.
 *
 * `undefined` when no config file was found: §4.1's patch is an *append* to a
 * `contracts` block, and inventing a whole file (with a `defineConfig` import
 * whose specifier depends on how the consumer installed Ambit) is not a patch
 * this command can generate safely (§5.3).
 */
function configTarget(
  config: ResolvedConfig | undefined,
  rootDir: string,
): ConfigTarget | undefined {
  if (!config) return undefined;
  return { path: config.displayPath, source: config.sourceText, rootDir };
}
