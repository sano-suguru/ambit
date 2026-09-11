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
import type { AuthorityRecord, Diagnostic, TsBackend } from "../core/index.ts";

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
  /**
   * The connection layer to extract with. Defaults to `legacyTsBackend`, the
   * backend DESIGN.md §3.5 adopted, and every product path leaves it unset —
   * `ambit check`, `ambit diff` and `ambit init` do not expose it, so the
   * authority for a diagnostic, an exit code and a review outcome is the
   * adopted backend and nothing else.
   *
   * It is here so that a *shadow* run (`scripts/shadow-analysis.ts`) can put a
   * second backend through the identical pipeline and compare Ambit's own
   * semantics rather than two compilers' ASTs. Passing one does not make it
   * authoritative: §3.5's default is changed by an RFC, not by a parameter.
   *
   * It is also not reachable from outside this repository. `analyze` is not
   * re-exported by `src/index.ts` and no subpath in `package.json`'s `exports`
   * leads to it, so the guaranteed surface §9.2 lists is unchanged and no
   * consumer can substitute a backend. Should `analyze` ever be published, this
   * option must not go with it: a measurement-only entry point belongs beside
   * it rather than inside it, or the library's authority boundary widens where
   * the CLI's did not.
   */
  readonly backend?: TsBackend;
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
  const backend = options.backend ?? legacyTsBackend;
  // The default path calls `legacyTsBackend.extractProject` by name rather
  // than through `backend`, and that is not a style choice: resolving this
  // callee needs the receiver's *value* followed to the declared function
  // (`legacyTsBackend: TsBackend = { extractProject }` makes the checker
  // return `TsBackend`'s member signature instead), and
  // `test/backend.legacy-ts.test.ts` asserts against this very call. Routing
  // it through a parameter would delete a resolved edge from Ambit's own
  // source: an unchanged tree would lose analysis it had.
  const project = options.backend
    ? await options.backend.extractProject(dir)
    : await legacyTsBackend.extractProject(dir);
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
  const engine = { name: backend.name, version: backend.version };
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
