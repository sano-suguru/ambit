/**
 * The regression gate for the shadow backend itself.
 *
 *     node scripts/shadow-check.ts            # compare against the recorded baseline
 *     node scripts/shadow-check.ts --update   # re-record it
 *
 * `pnpm test` protects the *comparator* (`test/shadow.compare.test.ts`, which
 * runs without the native compiler). Nothing protected the shadow backend, so
 * the 2026-09-12 note was a snapshot rather than telemetry: a port that started
 * naming a receiver wrongly, or silently stopped reading runtime budgets —
 * which is what had in fact happened — would have shown up only in whoever next
 * ran the analysis by hand and read the numbers carefully.
 *
 * This cannot live in `pnpm test`. The native compiler is deliberately not a
 * dependency (`scripts/m05-probe/native-compiler.ts` records why the two must
 * not share a `node_modules/.bin`), so the gate is a separate, opt-in job:
 * `.github/workflows/shadow.yml` installs it first and runs this.
 *
 * What it asserts, per root:
 *
 * - the self-check is clean — the adopted backend against itself must diverge
 *   nowhere, or every number after it is noise;
 * - no root gained a **high-risk** divergence. Those are the ones where the
 *   shadow side reports less authority or fewer `unknown`s, computed from the
 *   values themselves and never from a classification;
 * - no root gained an **unclassified** divergence. A new shape the backend did
 *   not itself declare as `NOT_PORTED` is exactly what a regression looks like;
 * - no root gained divergences overall.
 *
 * Improvements never fail the gate; they print, and `--update` records them.
 * The gate is one-sided on purpose — a threshold that punished progress would
 * be an argument for leaving the numbers alone.
 *
 * Exit codes: 0 clean, 1 a root regressed, 2 the run could not be made.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ShadowReport } from "./shadow/compare.ts";
import { NOT_PORTED, nativeTs7Backend } from "./shadow/native-ts7-backend.ts";
import { compareRoot } from "./shadow/run-root.ts";

/**
 * The roots the gate covers, and what each is here to catch. Diversity of
 * *shape* is the selection rule, not count: one more fixture exercising an
 * already-covered shape adds runtime and no signal.
 */
const ROOTS: readonly string[] = [
  "src",
  "test/fixtures/backend-conformance",
  "test/fixtures/backend-smoke",
  "test/fixtures/cross-module",
  "test/fixtures/held-receiver",
  "test/fixtures/factory-receiver",
  "test/fixtures/construction",
  "test/fixtures/http-clients",
  "test/fixtures/wrappers",
  "test/fixtures/next-app",
  "test/fixtures/realistic-api",
  "test/fixtures/propagation",
  "test/fixtures/contracts",
  "test/fixtures/mutation",
];

const BASELINE = path.resolve(import.meta.dirname, "..", "test", "shadow", "baseline.json");

interface RootBaseline {
  readonly divergences: number;
  readonly highRisk: number;
  readonly unclassified: number;
  /** Divergence counts by classification, so a shift between them is visible even when the total holds. */
  readonly byClassification: Readonly<Record<string, number>>;
  readonly authorityParity: number;
  readonly calleeResolutionParity: number;
  readonly unknownRateDelta: number;
  readonly decisionsAgree: boolean;
}

interface Baseline {
  readonly schema: "ambit-shadow-baseline/1";
  readonly notPorted: readonly string[];
  readonly roots: Readonly<Record<string, RootBaseline>>;
}

async function reportFor(root: string, selfCheck: boolean): Promise<ShadowReport> {
  const { report, errors } = await compareRoot(root, selfCheck);
  if (!report) {
    const detail = errors.map((e) => `${e.backend} failed during ${e.phase}: ${e.message}`);
    // A side that did not run is not a clean gate (DESIGN.md §3.4).
    throw new Error(`${root}: the comparison could not be made\n  ${detail.join("\n  ")}`);
  }
  return report;
}

function summarize(report: ShadowReport): RootBaseline {
  const byClassification: Record<string, number> = {};
  for (const divergence of report.divergences) {
    byClassification[divergence.classification] =
      (byClassification[divergence.classification] ?? 0) + 1;
  }
  return {
    divergences: report.divergences.length,
    highRisk: report.highRiskCount,
    unclassified: byClassification.unclassified ?? 0,
    byClassification,
    authorityParity: Number(report.parity.authority.rate.toFixed(4)),
    calleeResolutionParity: Number(report.parity.calleeResolution.rate.toFixed(4)),
    unknownRateDelta: Number(report.unknownRate.delta.toFixed(4)),
    decisionsAgree: report.decision.agree,
  };
}

function regressions(root: string, before: RootBaseline, now: RootBaseline): readonly string[] {
  const found: string[] = [];
  const worse = (what: string, was: number, is: number): void => {
    if (is > was) found.push(`${root}: ${what} ${was} -> ${is}`);
  };
  worse("high-risk divergences", before.highRisk, now.highRisk);
  worse("unclassified divergences", before.unclassified, now.unclassified);
  worse("divergences", before.divergences, now.divergences);
  if (before.decisionsAgree && !now.decisionsAgree) {
    found.push(`${root}: the two backends no longer agree on the CI decision`);
  }
  if (now.unknownRateDelta < before.unknownRateDelta) {
    found.push(
      `${root}: the shadow side's unknown rate fell relative to the adopted one (${before.unknownRateDelta} -> ${now.unknownRateDelta} pt)`,
    );
  }
  return found;
}

async function main(): Promise<number> {
  const update = process.argv.includes("--update");

  // Refuses rather than falling back to the adopted backend on both sides: a
  // clean gate that means "the shadow backend never ran" is the failure
  // DESIGN.md §3.4 forbids.
  if (!nativeTs7Backend.version) {
    process.stderr.write(
      "the native compiler reported no version.\nRun: node scripts/m05-native-install.ts\n",
    );
    return 2;
  }

  const selfCheck = await reportFor("src", true);
  if (selfCheck.divergences.length > 0) {
    process.stderr.write(
      `self-check failed: the adopted backend diverged from itself in ${selfCheck.divergences.length} place(s).\n` +
        "Every parity number after this is noise; fix the comparison first.\n",
    );
    return 1;
  }
  process.stdout.write("self-check clean (adopted backend against itself, src)\n\n");

  const now: Record<string, RootBaseline> = {};
  for (const root of ROOTS) {
    now[root] = summarize(await reportFor(root, false));
  }

  if (update) {
    const baseline: Baseline = {
      schema: "ambit-shadow-baseline/1",
      notPorted: NOT_PORTED,
      roots: now,
    };
    writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
    process.stdout.write(`recorded ${path.relative(process.cwd(), BASELINE)}\n`);
    return 0;
  }

  if (!existsSync(BASELINE)) {
    process.stderr.write(
      `no baseline at ${path.relative(process.cwd(), BASELINE)}.\nRun: node scripts/shadow-check.ts --update\n`,
    );
    return 2;
  }
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;

  const found: string[] = [];
  const improved: string[] = [];
  for (const root of ROOTS) {
    const before = baseline.roots[root];
    const current = now[root];
    if (!current) continue;
    if (!before) {
      found.push(`${root}: not in the baseline — re-record it deliberately, not by accident`);
      continue;
    }
    found.push(...regressions(root, before, current));
    if (current.divergences < before.divergences) {
      improved.push(
        `${root}: divergences ${before.divergences} -> ${current.divergences} (high-risk ${before.highRisk} -> ${current.highRisk})`,
      );
    }
    process.stdout.write(
      `${root.padEnd(34)} divergences ${String(current.divergences).padStart(4)}  high-risk ${String(current.highRisk).padStart(3)}  unclassified ${String(current.unclassified).padStart(3)}\n`,
    );
  }

  const droppedShapes = baseline.notPorted.filter((shape) => !NOT_PORTED.includes(shape));
  if (droppedShapes.length > 0) {
    process.stdout.write(`\nno longer in NOT_PORTED: ${droppedShapes.join(", ")}\n`);
  }
  const addedShapes = NOT_PORTED.filter((shape) => !baseline.notPorted.includes(shape));
  if (addedShapes.length > 0) {
    // Adding a shape is a widened gap, not a regression in itself, but it must
    // never happen silently — the honesty of every parity number rests on the
    // list being complete.
    process.stdout.write(`\nnewly declared NOT_PORTED: ${addedShapes.join(", ")}\n`);
  }

  if (improved.length > 0) {
    process.stdout.write(`\nimproved:\n${improved.map((line) => `  ${line}`).join("\n")}\n`);
    process.stdout.write("  run with --update to record these\n");
  }
  if (found.length > 0) {
    process.stderr.write(`\nregressed:\n${found.map((line) => `  ${line}`).join("\n")}\n`);
    return 1;
  }
  process.stdout.write("\nno regression against the recorded baseline\n");
  return 0;
}

process.exitCode = await main();
