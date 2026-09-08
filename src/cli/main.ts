#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { diagnose, legacyTsBackend, propagate, summarizeExtractedFiles } from "../checker/index.ts";
import type { Diagnostic } from "../core/index.ts";

/**
 * Exit codes (plan step 9): distinguish "checked, no error-level violation"
 * from "the check itself could not run" (DESIGN.md §3.4 — never turn an
 * analysis failure into "no violations").
 */
const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_ANALYSIS_FAILED = 2;

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.error) {
    process.stderr.write(`ambit check: ${args.error}\nUsage: ambit check <dir> [--format json]\n`);
    return EXIT_ANALYSIS_FAILED;
  }
  if (args.command !== "check") {
    process.stderr.write(
      `Unknown command: ${args.command}\nUsage: ambit check <dir> [--format json]\n`,
    );
    return EXIT_ANALYSIS_FAILED;
  }

  let diagnostics: readonly Diagnostic[];
  try {
    const files = await legacyTsBackend.extractProject(args.dir);
    const summaries = summarizeExtractedFiles(files);
    const state = propagate(summaries);
    diagnostics = diagnose(state, {
      name: legacyTsBackend.name,
      version: legacyTsBackend.version,
    });
  } catch (error) {
    process.stderr.write(`ambit check: analysis failed: ${errorMessage(error)}\n`);
    return EXIT_ANALYSIS_FAILED;
  }

  for (const diagnostic of diagnostics) {
    process.stdout.write(args.format === "json" ? formatJson(diagnostic) : formatText(diagnostic));
  }

  const hasError = diagnostics.some((d) => d.severity === "error");
  return hasError ? EXIT_VIOLATIONS : EXIT_OK;
}

interface Args {
  readonly command: string;
  readonly dir: string;
  readonly format: "json" | "text";
  /** Set when argv could not be parsed; `main` reports it and exits 2 rather than running with a silently-ignored option (DESIGN.md §3.4). */
  readonly error?: string;
}

const KNOWN_FLAGS = new Set(["--format"]);

function parseArgs(argv: readonly string[]): Args {
  const [command = "check", ...rest] = argv;
  let dir = ".";
  let format: "json" | "text" = "text";

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--format") {
      const value = rest[i + 1];
      if (value !== "json" && value !== "text") {
        return {
          command,
          dir,
          format,
          error: `--format expects "json" or "text", got ${value === undefined ? "nothing" : JSON.stringify(value)}`,
        };
      }
      format = value;
      i++;
    } else if (arg?.startsWith("--")) {
      if (!KNOWN_FLAGS.has(arg)) {
        return { command, dir, format, error: `unknown option: ${arg}` };
      }
    } else if (arg) {
      dir = arg;
    }
  }

  return { command, dir, format };
}

function formatJson(diagnostic: Diagnostic): string {
  return `${JSON.stringify(diagnostic)}\n`;
}

/** Minimal human-readable form. `--format json` (NDJSON, DESIGN.md §5.1) is this slice's real output. */
function formatText(diagnostic: Diagnostic): string {
  const { severity, message, location } = diagnostic;
  return `${severity}: ${message} (${location.file}:${location.line})\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Only run when this file is the process entry point (`node src/cli/main.ts
// ...`), not when it's imported by a test or another module.
// pathToFileURL (rather than a plain `file://` template) also matches when
// invoked through a symlinked `bin` entry or a path containing spaces.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`ambit check: unexpected failure: ${errorMessage(error)}\n`);
      process.exitCode = EXIT_ANALYSIS_FAILED;
    });
}
