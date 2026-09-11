/**
 * Shadow analysis — run the adopted backend and the TypeScript 7 one over the
 * same tree and compare what Ambit makes of each.
 *
 *     node scripts/shadow-analysis.ts <dir> [--json <path>] [--self-check]
 *
 *     node scripts/shadow-analysis.ts src --json .shadow/src.json
 *     node scripts/shadow-analysis.ts test/fixtures/backend-conformance
 *     node scripts/shadow-analysis.ts src --self-check
 *
 * `--self-check` runs the *adopted* backend on both sides. It must report zero
 * divergences; anything else is a bug in the comparison rather than in either
 * compiler, and it is the cheapest way to find one.
 *
 * This is a measurement procedure (AGENTS.md, "scripts/"). It changes no
 * diagnostic, no exit code and no review outcome: DESIGN.md §3.5 and ADR-0001
 * adopted `typescript-legacy`, the shadow side is never authoritative, and the
 * default backend changes by an RFC (§9), not by this script printing a good
 * number.
 *
 * Exit codes are about the *run*, not about the parity: 0 when the comparison
 * completed, 2 when it could not. A divergence is a finding to read, not a
 * failure — wiring a threshold here would make the shadow side authoritative
 * by the back door.
 *
 * Requires the native compiler in `.m05-native/`:
 *
 *     node scripts/m05-native-install.ts
 *
 * If it is missing the run stops. It does not fall back to comparing the
 * adopted backend against itself and reporting perfect parity — a report whose
 * zero divergences mean "the shadow backend never ran" is exactly the failure
 * DESIGN.md §3.4 forbids.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { nativeTs7Backend } from "./shadow/native-ts7-backend.ts";
import { renderSummary } from "./shadow/report.ts";
import { compareRoot } from "./shadow/run-root.ts";

function parseArgs(argv: readonly string[]): {
  readonly dir: string;
  readonly jsonPath?: string;
  readonly selfCheck: boolean;
} {
  const rest = [...argv];
  let jsonPath: string | undefined;
  let selfCheck = false;
  const positional: string[] = [];
  while (rest.length > 0) {
    const argument = rest.shift();
    if (argument === undefined) break;
    if (argument === "--json") {
      const value = rest.shift();
      if (value === undefined) throw new Error("--json needs a path");
      jsonPath = value;
    } else if (argument === "--self-check") {
      selfCheck = true;
    } else if (argument.startsWith("--")) {
      throw new Error(`unknown option ${argument}`);
    } else {
      positional.push(argument);
    }
  }
  const dir = positional[0];
  if (dir === undefined)
    throw new Error("usage: node scripts/shadow-analysis.ts <dir> [--json <path>] [--self-check]");
  return { dir, ...(jsonPath ? { jsonPath } : {}), selfCheck };
}

async function main(): Promise<void> {
  const { dir, jsonPath, selfCheck } = parseArgs(process.argv.slice(2));

  // Fails loudly here rather than producing a report with nothing in it.
  if (!selfCheck && !nativeTs7Backend.version) {
    throw new Error("the native compiler reported no version");
  }

  const { report, errors } = await compareRoot(dir, selfCheck);
  if (!report) {
    for (const error of errors) {
      console.error(`${error.backend} failed during ${error.phase}: ${error.message}`);
    }
    // A side that did not run is not a parity of zero divergences.
    process.exitCode = 2;
    return;
  }

  if (jsonPath) {
    const absolute = path.resolve(jsonPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.relative(process.cwd(), absolute)}`);
  }
  process.stdout.write(renderSummary(report));

  if (selfCheck && report.divergences.length > 0) {
    console.error(
      `--self-check found ${report.divergences.length} divergences comparing the adopted backend with itself: the comparison is wrong, not the compilers`,
    );
    process.exitCode = 2;
  }
}

await main();
