#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CoverageReport } from "../checker/coverage.ts";
import {
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
import type { Diagnostic } from "../core/index.ts";
import { displayName, isEffectsContract } from "../core/index.ts";

/**
 * Exit codes (plan step 9): distinguish "checked, no error-level violation"
 * from "the check itself could not run" (DESIGN.md §3.4 — never turn an
 * analysis failure into "no violations").
 */
const USAGE = `Usage: ambit check <dir> [--format json] [--coverage] [--strict]
       ambit init  <dir> [--format json] [--config]   propose @effects for undeclared functions
`;

const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_ANALYSIS_FAILED = 2;

/** @effects fs_read */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`ambit: ${args.error}\n${USAGE}`);
    return EXIT_ANALYSIS_FAILED;
  }
  if (args.command !== "check" && args.command !== "init") {
    process.stderr.write(`Unknown command: ${args.command}\n${USAGE}`);
    return EXIT_ANALYSIS_FAILED;
  }

  let diagnostics: readonly Diagnostic[];
  let coverage: CoverageReport;
  try {
    // Loaded before extraction so a broken config stops the run before any
    // work is reported (DESIGN.md §3.4): a config that could not be read must
    // never come out as "checked, no violations".
    const loaded = await loadConfig(args.dir);
    const config: ResolvedConfig | undefined = loaded ? resolveConfig(loaded, args.dir) : undefined;
    const project = await legacyTsBackend.extractProject(args.dir);
    // No extracted function anywhere means "nothing analyzable was found"
    // (zero .ts files, or every function-like node was skipped) — that must
    // not read the same as "checked, no violations" (DESIGN.md §3.4). Counted
    // over functions rather than over `files`, because a file can now be
    // pushed for its `withAmbit` wrappers alone.
    const functionsFound = project.files.reduce((total, file) => total + file.functions.length, 0);
    if (functionsFound === 0) {
      throw new Error(`no analyzable functions found under ${args.dir}`);
    }
    const summaries = summarizeExtractedFiles(project.files, config);
    const state = propagate(summaries);
    const engine = { name: legacyTsBackend.name, version: legacyTsBackend.version };
    diagnostics =
      args.command === "init"
        ? proposeContracts(state, engine, args.config ? configTarget(config, args.dir) : undefined)
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
            args.strict,
            config,
          );
    coverage = computeCoverage({
      filesAnalyzed: project.files.length,
      skippedFunctions: project.skippedFunctions,
      summaries,
      state,
    });
  } catch (error) {
    process.stderr.write(`ambit: analysis failed: ${errorMessage(error)}\n`);
    return EXIT_ANALYSIS_FAILED;
  }

  for (const diagnostic of diagnostics) {
    process.stdout.write(args.format === "json" ? formatJson(diagnostic) : formatText(diagnostic));
  }

  // Always report what was analyzed — a silent, empty result must never
  // read the same as "checked and found nothing" (DESIGN.md §3.4). The
  // detailed unresolved-reason/name breakdown is opt-in via --coverage.
  process.stdout.write(
    args.format === "json" ? formatSummaryJson(coverage) : formatSummaryText(coverage),
  );
  if (args.coverage) {
    process.stdout.write(
      args.format === "json" ? formatCoverageJson(coverage) : formatCoverageText(coverage),
    );
  }

  // `init` reports proposals, not violations: a codebase with contracts left
  // to write has not failed a check, so it must not exit non-zero.
  if (args.command === "init") return EXIT_OK;

  const hasError = diagnostics.some((d) => d.severity === "error");
  return hasError ? EXIT_VIOLATIONS : EXIT_OK;
}

interface Args {
  readonly command: string;
  readonly dir: string;
  readonly format: "json" | "text";
  readonly coverage: boolean;
  /** `--strict`: promote the `unknown` warnings to errors (DESIGN.md §4.2 rule 3). */
  readonly strict: boolean;
  /** `init --config`: also propose `ambit.config.ts` entries for declarations JSDoc cannot carry (§4.1 (a)). */
  readonly config: boolean;
  /** Set when argv could not be parsed; `main` reports it and exits 2 rather than running with a silently-ignored option (DESIGN.md §3.4). */
  readonly error?: string;
}

const KNOWN_FLAGS = new Set(["--format", "--coverage", "--strict", "--config"]);

/**
 * The diagnostics `--strict` promotes to errors: the two that say "analysis
 * reached something it could not resolve" (DESIGN.md §4.2 rule 3 — 「Ambit の
 * `strict: true` でエラーに昇格できる」). Deliberately not every warning:
 * `--strict` means "an unverified path is not acceptable here", which is a
 * different claim from promoting, say, an entrypoint's missing capability set.
 */
const STRICT_PROMOTED_IDS: ReadonlySet<string> = new Set(["AMB-W001", "AMB-W003"]);

/**
 * `--strict` promotes everywhere; `strict` in `ambit.config.ts` promotes only
 * inside the globs it lists (DESIGN.md §4.3: 「`ambit.config.ts` でディレクトリ
 * 単位に `strict` を設定できる。新規コードから締め、レガシーは警告のまま
 * にする」). The two are a union, so `--strict` on the command line is never
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

function parseArgs(argv: readonly string[]): Args {
  const [command = "check", ...rest] = argv;
  let dir = ".";
  let format: "json" | "text" = "text";
  let coverage = false;
  let strict = false;
  let config = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--format") {
      const value = rest[i + 1];
      if (value !== "json" && value !== "text") {
        return {
          command,
          dir,
          format,
          coverage,
          strict,
          config,
          error: `--format expects "json" or "text", got ${value === undefined ? "nothing" : JSON.stringify(value)}`,
        };
      }
      format = value;
      i++;
    } else if (arg === "--coverage") {
      coverage = true;
    } else if (arg === "--strict") {
      strict = true;
    } else if (arg === "--config") {
      config = true;
    } else if (arg?.startsWith("--")) {
      if (!KNOWN_FLAGS.has(arg)) {
        return { command, dir, format, coverage, strict, config, error: `unknown option: ${arg}` };
      }
    } else if (arg) {
      dir = arg;
    }
  }

  return { command, dir, format, coverage, strict, config };
}

function formatJson(diagnostic: Diagnostic): string {
  return `${JSON.stringify(diagnostic)}\n`;
}

/**
 * Human-readable form, rendered from the structured diagnostic (DESIGN.md §5:
 * 「人間向け表示は構造化診断からのレンダリングとして実装する」).
 *
 * The header line reports the function that declared the contract, at its own
 * `file:line`. `contract.via` — the call path from there to the function that
 * carries what was observed — follows as one indented line per hop, each with
 * its own `file:line`, so the middle of the path is readable without
 * re-running the check with `--format json`.
 */
function formatText(diagnostic: Diagnostic): string {
  const { severity, message, location } = diagnostic;
  const header = `${severity}: ${message} (${location.file}:${location.line})\n`;
  return (
    header +
    viaPath(diagnostic)
      .map((hop) => `  ${hop}\n`)
      .join("")
  );
}

/**
 * One entry per hop in `contract.via`, as `-> name (file:line)`.
 *
 * Empty when the diagnostic has no hops: the effect is performed in the
 * reported function's own body, so there is no call path, and a path that does
 * not exist is not synthesized (DESIGN.md §5.3 — the same rule that forbids
 * fabricating a fix candidate).
 */
function viaPath(diagnostic: Diagnostic): readonly string[] {
  const contract = diagnostic.contract;
  const via = contract?.via ?? [];
  // The operation site is not a hop — it is where, inside the last function of
  // the path, the effect is performed — so it is labelled rather than arrowed,
  // and it appears for a direct diagnostic that has no path at all.
  const operation = contract && isEffectsContract(contract) ? contract.operation : undefined;
  return [
    ...via.map((hop) => `-> ${displayName(hop.symbol)} (${hop.file}:${hop.line})`),
    ...(operation
      ? [`operation: ${operation.qualifiedName} (${operation.file}:${operation.line})`]
      : []),
  ];
}

function formatSummaryText(coverage: CoverageReport): string {
  return `files=${coverage.filesAnalyzed} functions=${coverage.functionsExtracted} declared=${coverage.functionsDeclared}\n`;
}

function formatSummaryJson(coverage: CoverageReport): string {
  return `${JSON.stringify({
    kind: "summary",
    filesAnalyzed: coverage.filesAnalyzed,
    functionsExtracted: coverage.functionsExtracted,
    functionsDeclared: coverage.functionsDeclared,
  })}\n`;
}

function formatCoverageText(coverage: CoverageReport): string {
  const unknownPct = (coverage.functionUnknownRate * 100).toFixed(1);
  // Reported beside the unknown rate on purpose: a boundary leaves the
  // unknown numerator without the body ever being checked, so reading one
  // number without the other would show declaring boundaries as progress.
  const boundaryPct = (coverage.functionBoundaryRate * 100).toFixed(1);
  const lines = [
    `declared-by: jsdoc=${coverage.functionsDeclaredByJsDoc} config=${coverage.functionsDeclaredByConfig}`,
    `unknown-rate=${unknownPct}% (${Math.round(coverage.functionUnknownRate * coverage.functionsExtracted)}/${coverage.functionsExtracted} functions) boundary-rate=${boundaryPct}% (${coverage.functionsBoundary}/${coverage.functionsExtracted} functions)`,
    `entrypoints=${coverage.functionsEntrypoint} (without-capabilities=${coverage.entrypointsWithoutCapabilities})`,
    `skipped=${coverage.functionsSkipped} (${mapEntries(coverage.skippedByKind)})`,
    `call-sites: total=${coverage.callSitesTotal} resolved=${coverage.callSitesResolved} stub=${coverage.callSitesStub} pure=${coverage.callSitesPure} mutation=${coverage.callSitesMutation} unresolved=${coverage.callSitesUnresolved}`,
    `unresolved-by-reason: ${mapEntries(coverage.unresolvedByReason)}`,
  ];
  if (coverage.topUnresolvedNames.length > 0) {
    lines.push(
      `top-unresolved-names: ${coverage.topUnresolvedNames.map((n) => `${n.name}=${n.count}`).join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function formatCoverageJson(coverage: CoverageReport): string {
  return `${JSON.stringify({
    kind: "coverage",
    functionsDeclaredByJsDoc: coverage.functionsDeclaredByJsDoc,
    functionsDeclaredByConfig: coverage.functionsDeclaredByConfig,
    functionUnknownRate: coverage.functionUnknownRate,
    functionBoundaryRate: coverage.functionBoundaryRate,
    functionsBoundary: coverage.functionsBoundary,
    functionsEntrypoint: coverage.functionsEntrypoint,
    entrypointsWithoutCapabilities: coverage.entrypointsWithoutCapabilities,
    functionsSkipped: coverage.functionsSkipped,
    skippedByKind: Object.fromEntries(coverage.skippedByKind),
    callSitesTotal: coverage.callSitesTotal,
    callSitesResolved: coverage.callSitesResolved,
    callSitesStub: coverage.callSitesStub,
    callSitesPure: coverage.callSitesPure,
    callSitesMutation: coverage.callSitesMutation,
    callSitesUnresolved: coverage.callSitesUnresolved,
    unresolvedByReason: Object.fromEntries(coverage.unresolvedByReason),
    topUnresolvedNames: coverage.topUnresolvedNames,
  })}\n`;
}

function mapEntries(map: ReadonlyMap<string, number>): string {
  if (map.size === 0) return "none";
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when this file is the process entry point (`node src/cli/main.ts ...`,
 * or the installed `ambit` bin), false when a test or another module imports
 * it.
 *
 * npm installs `bin` as a symlink (`node_modules/.bin/ambit ->
 * ../ambit/dist/cli/main.js`), and `process.argv[1]` is then the *symlink*
 * path while `import.meta.url` is the resolved target — so comparing the two
 * directly makes the installed CLI silently do nothing and exit 0, which reads
 * exactly like "checked, no violations" (DESIGN.md §3.4 forbids that). The
 * symlink is resolved before comparing. `pathToFileURL` (rather than a plain
 * `file://` template) also handles a path containing spaces.
 */
function isProcessEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = entry;
  }
  return import.meta.url === pathToFileURL(resolved).href;
}

if (isProcessEntryPoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`ambit: unexpected failure: ${errorMessage(error)}\n`);
      process.exitCode = EXIT_ANALYSIS_FAILED;
    });
}
