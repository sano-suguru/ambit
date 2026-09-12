import {
  type AnalysisResult,
  buildReport,
  type ConfigTarget,
  legacyTsBackend,
  loadConfig,
  propagate,
  type ResolvedConfig,
  resolveConfig,
  summarizeExtractedFiles,
} from "../checker/index.ts";
import type { TsBackend } from "../core/index.ts";

/** One run of the analysis over one directory. */
export type Analysis = AnalysisResult;

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
 * This is also the oracle the resident path (DESIGN.md §6.2) is tested
 * against, so it stays a pure function of the directory: nothing here is
 * allowed to become a cache.
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

  return buildReport({
    state,
    summaries,
    uncarriedContracts: project.uncarriedContracts,
    runtimeWrappers: project.files.flatMap((file) => file.runtimeWrappers),
    // Read after every lookup has run, which is what `unmatchedExactKeys`
    // requires — `contractFor` records matches as a side effect.
    unmatchedExactKeys: config ? config.unmatchedExactKeys() : [],
    filesAnalyzed: project.files.length,
    skippedFunctions: project.skippedFunctions,
    engine: { name: backend.name, version: backend.version },
    config,
    strict: options.strict ?? false,
    ...(options.propose ? { propose: true as const } : {}),
    ...(options.propose && options.proposeConfig
      ? { proposeTarget: configTarget(config, dir) }
      : {}),
  });
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
