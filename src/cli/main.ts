#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { CoverageReport } from "../checker/coverage.ts";
import type { Diagnostic } from "../core/index.ts";
import { displayName, hasAuthorityIncrease, isEffectsContract } from "../core/index.ts";
import { type Analysis, analyze } from "./analyze.ts";
import { formatDiffGithub, formatDiffText, runDiff } from "./diff.ts";
import { githubAnnotation, workspacePath } from "./github.ts";

/**
 * Exit codes (plan step 9): distinguish "checked, no error-level violation"
 * from "the check itself could not run" (DESIGN.md §3.4 — never turn an
 * analysis failure into "no violations").
 */
const USAGE = `Usage: ambit check <dir> [--format json|github] [--coverage] [--strict]
       ambit init  <dir> [--format json] [--config]   propose @effects for undeclared functions
       ambit diff  <ref> [dir] [--format github]      report authority the working tree gained over <ref>
`;

const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_ANALYSIS_FAILED = 2;

/**
 * `diff` shells out to git and writes a worktree, so the entry point's own
 * contract is wider than `check`'s alone (DESIGN.md §6).
 *
 * @effects fs_read, fs_write, process
 */
export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`ambit: ${args.error}\n${USAGE}`);
    return EXIT_ANALYSIS_FAILED;
  }
  if (args.command === "diff") return await diffCommand(args);
  if (args.command !== "check" && args.command !== "init") {
    process.stderr.write(`Unknown command: ${args.command}\n${USAGE}`);
    return EXIT_ANALYSIS_FAILED;
  }

  let analysis: Analysis;
  try {
    analysis = await analyze(args.dir, {
      propose: args.command === "init",
      proposeConfig: args.config,
      strict: args.strict,
    });
  } catch (error) {
    process.stderr.write(`ambit: analysis failed: ${errorMessage(error)}\n`);
    return EXIT_ANALYSIS_FAILED;
  }
  const { diagnostics, authority, coverage } = analysis;

  for (const diagnostic of diagnostics) {
    process.stdout.write(formatDiagnostic(diagnostic, args));
  }

  // The per-function authority records (DESIGN.md §5.1). Emitted after the
  // diagnostics and before the trailing `summary` line, so a consumer that
  // reads the last record as the summary keeps working, and only for `check`:
  // `init` reports proposals about contracts that do not exist yet.
  if (args.format === "json" && args.command === "check") {
    for (const record of authority) {
      process.stdout.write(`${JSON.stringify(record)}\n`);
    }
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

/**
 * `ambit diff <ref>`: what authority the working tree gained over `ref`
 * (DESIGN.md §6).
 *
 * @effects process, fs_read, fs_write
 */
async function diffCommand(args: Args): Promise<number> {
  let result: Awaited<ReturnType<typeof runDiff>>;
  try {
    result = await runDiff(args.ref, args.dir);
  } catch (error) {
    // Either side failing to analyze is exit 2, never 0: a comparison that
    // could not be made must not read as "nothing increased" (DESIGN.md §3.4).
    process.stderr.write(`ambit: diff failed: ${errorMessage(error)}\n`);
    return EXIT_ANALYSIS_FAILED;
  }
  process.stdout.write(
    args.format === "github" ? formatDiffGithub(result) : formatDiffText(result),
  );
  // An increase, or a new symbol that holds authority, fails (DESIGN.md §6).
  // A decrease and a deletion are reported and pass: taking authority away is
  // not the thing this command is watching for, and failing on it would give
  // an author a reason to leave a contract alone.
  return hasAuthorityIncrease(result.diff) ? EXIT_VIOLATIONS : EXIT_OK;
}

interface Args {
  readonly command: string;
  readonly dir: string;
  /** `diff <ref>`: the base revision. Empty for every other command. */
  readonly ref: string;
  readonly format: OutputFormat;
  readonly coverage: boolean;
  /** `--strict`: promote the `unknown` warnings to errors (DESIGN.md §4.2 rule 3). */
  readonly strict: boolean;
  /** `init --config`: also propose `ambit.config.ts` entries for declarations JSDoc cannot carry (§4.1 (a)). */
  readonly config: boolean;
  /** Set when argv could not be parsed; `main` reports it and exits 2 rather than running with a silently-ignored option (DESIGN.md §3.4). */
  readonly error?: string;
}

const KNOWN_FLAGS = new Set(["--format", "--coverage", "--strict", "--config"]);

function parseArgs(argv: readonly string[]): Args {
  const [command = "check", ...rest] = argv;
  let dir = ".";
  // `diff` takes the base ref first and the directory second; every other
  // command's first positional is the directory.
  let ref = "";
  const positionals: string[] = [];
  let format: OutputFormat = "text";
  let coverage = false;
  let strict = false;
  let config = false;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--format") {
      const value = rest[i + 1];
      if (!isOutputFormat(value)) {
        return {
          command,
          dir,
          ref,
          format,
          coverage,
          strict,
          config,
          error: `--format expects ${OUTPUT_FORMATS.map((f) => JSON.stringify(f)).join(", ")}, got ${value === undefined ? "nothing" : JSON.stringify(value)}`,
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
        return {
          command,
          dir,
          ref,
          format,
          coverage,
          strict,
          config,
          error: `unknown option: ${arg}`,
        };
      }
    } else if (arg) {
      positionals.push(arg);
    }
  }

  if (command === "diff") {
    const [first, second] = positionals;
    if (first === undefined) {
      return { command, dir, ref, format, coverage, strict, config, error: "diff expects a ref" };
    }
    ref = first;
    if (second !== undefined) dir = second;
  } else {
    const [first] = positionals;
    if (first !== undefined) dir = first;
  }

  return { command, dir, ref, format, coverage, strict, config };
}

/**
 * `--format` values. `text` is for a human at a terminal, `json` is the NDJSON
 * of DESIGN.md §5.1 for agents and tools, and `github` renders the same
 * structured diagnostic as GitHub Actions workflow commands so a CI run
 * annotates the offending lines — §6: 「CI は終了コードと構造化出力で統合する。
 * 専用 CI プラグインを必須にしない」.
 */
const OUTPUT_FORMATS = ["text", "json", "github"] as const;

type OutputFormat = (typeof OUTPUT_FORMATS)[number];

function isOutputFormat(value: string | undefined): value is OutputFormat {
  return OUTPUT_FORMATS.some((format) => format === value);
}

function formatDiagnostic(diagnostic: Diagnostic, args: Args): string {
  if (args.format === "json") return formatJson(diagnostic);
  if (args.format === "github") return formatGithub(diagnostic, args.dir);
  return formatText(diagnostic);
}

const GITHUB_COMMAND: Readonly<Record<Diagnostic["severity"], string>> = {
  error: "error",
  warning: "warning",
  info: "notice",
};

/**
 * One GitHub Actions workflow command per diagnostic
 * (`::error file=...,line=...::message`), which is what makes a failing check
 * annotate the offending line in a pull request without installing anything —
 * DESIGN.md §6's "専用 CI プラグインを必須にしない".
 *
 * The call path and the operation site are folded into the message with `%0A`
 * so the annotation is self-sufficient: a reader on the diff sees every hop
 * without opening the job log.
 *
 * `location.file` is relative to the directory that was checked, while an
 * annotation is resolved from the workspace root, so the path is re-expressed
 * relative to the working directory.
 */
function formatGithub(diagnostic: Diagnostic, rootDir: string): string {
  const { location } = diagnostic;
  return githubAnnotation({
    severity: GITHUB_COMMAND[diagnostic.severity],
    file: workspacePath(rootDir, location.file),
    line: location.line,
    col: location.col,
    title: diagnostic.id,
    body: [diagnostic.message, ...viaPath(diagnostic)],
  });
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
