/**
 * The analysis-quality benchmark: what fraction of a real project's functions
 * Ambit can say something definite about.
 *
 *     node scripts/bench-corpus.ts [--json]
 *
 * One command checks out the fixed corpus (`test/corpus/corpus.json`, pinned by
 * commit and by subtree tree object) and reports, per target and across
 * targets, `docs/DESIGN.md` §4.3's primary KPI — the proportion of extracted
 * functions whose propagated effect set carries `unknown`.
 *
 * It runs the analysis through the library API rather than through `ambit
 * check` for one reason: `--coverage`'s `top-unresolved-names` is capped at ten
 * entries, and the cap is there for a human reading a terminal. Deciding *what
 * to work on next* needs the whole histogram, and widening the CLI's output
 * would be a change to §9.2's guaranteed surface for the sake of a measurement
 * procedure. Everything else it reports comes from `computeCoverage`, the same
 * function `--coverage` prints.
 *
 * `pnpm test` does not run this: it fetches from the network.
 */

import process from "node:process";
import { computeCoverage, legacyTsBackend, propagate, summarizeExtractedFiles } from "../src/checker/index.ts";
import type { UnresolvedReason } from "../src/core/index.ts";
import { type CheckedOutTarget, ensureCorpus } from "./corpus.ts";

/** How many unresolved-call names to print per target — the "what to stub next" signal. */
const TOP_NAMES = 15;

interface TargetResult {
  readonly name: string;
  readonly what: string;
  readonly commit: string;
  readonly subdir: string;
  readonly tree: string;
  readonly filesAnalyzed: number;
  readonly functionsTotal: number;
  readonly functionsKnown: number;
  readonly functionsUnknown: number;
  readonly unknownRate: number;
  readonly boundaryRate: number;
  readonly callSitesTotal: number;
  readonly callSitesUnresolved: number;
  readonly unresolvedByReason: readonly (readonly [UnresolvedReason, number])[];
  readonly topUnresolvedNames: readonly (readonly [string, number])[];
}

async function measure(target: CheckedOutTarget): Promise<TargetResult> {
  const extracted = await legacyTsBackend.extractProject(target.dir);
  const summaries = summarizeExtractedFiles(extracted.files);
  const state = propagate(summaries);
  const coverage = computeCoverage({
    filesAnalyzed: extracted.files.length,
    skippedFunctions: extracted.skippedFunctions,
    summaries,
    state,
  });

  // The full name histogram, uncapped — `computeCoverage` keeps only the top
  // ten, which is the right amount for a terminal and not enough to pick the
  // next lever from.
  const names = new Map<string, number>();
  for (const summary of summaries) {
    if (summary.boundary.kind === "declared") continue;
    for (const call of summary.calls) {
      if (call.kind !== "unresolved" || !call.qualifiedName) continue;
      names.set(call.qualifiedName, (names.get(call.qualifiedName) ?? 0) + 1);
    }
  }

  return {
    name: target.name,
    what: target.what,
    commit: target.commit,
    subdir: target.subdir,
    tree: target.observedTree,
    filesAnalyzed: coverage.filesAnalyzed,
    functionsTotal: coverage.functionsExtracted,
    functionsKnown: coverage.functionsExtracted - Math.round(coverage.functionUnknownRate * coverage.functionsExtracted),
    functionsUnknown: Math.round(coverage.functionUnknownRate * coverage.functionsExtracted),
    unknownRate: coverage.functionUnknownRate,
    boundaryRate: coverage.functionBoundaryRate,
    callSitesTotal: coverage.callSitesTotal,
    callSitesUnresolved: coverage.callSitesUnresolved,
    unresolvedByReason: [...coverage.unresolvedByReason.entries()].sort((a, b) => b[1] - a[1]),
    topUnresolvedNames: [...names.entries()]
      .sort(([nameA, countA], [nameB, countB]) => countB - countA || nameA.localeCompare(nameB))
      .slice(0, TOP_NAMES),
  };
}

/** The middle value for an odd count, the mean of the two middle values for an even one. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

const asJson = process.argv.includes("--json");
const targets = ensureCorpus();
const results: TargetResult[] = [];
for (const target of targets) {
  results.push(await measure(target));
}

const totals = {
  functionsTotal: results.reduce((n, r) => n + r.functionsTotal, 0),
  functionsKnown: results.reduce((n, r) => n + r.functionsKnown, 0),
  functionsUnknown: results.reduce((n, r) => n + r.functionsUnknown, 0),
};
const medianUnknownRate = median(results.map((r) => r.unknownRate));

if (asJson) {
  console.log(JSON.stringify({ results, totals, medianUnknownRate }, null, 2));
} else {
  console.log("Ambit analysis-quality benchmark (test/corpus/corpus.json)\n");
  const reasonTotals = new Map<UnresolvedReason, number>();
  for (const result of results) {
    console.log(`## ${result.name} — ${result.what}`);
    console.log(`   ${result.commit.slice(0, 12)} ${result.subdir} (tree ${result.tree.slice(0, 12)})`);
    console.log(
      `   files=${result.filesAnalyzed} functions=${result.functionsTotal} known=${result.functionsKnown} unknown=${result.functionsUnknown}`,
    );
    console.log(
      `   unknown-rate=${percent(result.unknownRate)} boundary-rate=${percent(result.boundaryRate)}`,
    );
    console.log(
      `   call-sites=${result.callSitesTotal} unresolved=${result.callSitesUnresolved}`,
    );
    console.log(
      `   unresolved-by-reason: ${result.unresolvedByReason.map(([r, n]) => `${r}=${n}`).join(", ") || "none"}`,
    );
    console.log(
      `   top-unresolved-names: ${result.topUnresolvedNames.map(([n, c]) => `${n}=${c}`).join(", ") || "none"}`,
    );
    console.log("");
    for (const [reason, count] of result.unresolvedByReason) {
      reasonTotals.set(reason, (reasonTotals.get(reason) ?? 0) + count);
    }
  }
  console.log("## corpus");
  console.log(
    `   targets=${results.length} functions=${totals.functionsTotal} known=${totals.functionsKnown} unknown=${totals.functionsUnknown}`,
  );
  for (const result of results) {
    console.log(
      `   ${result.name.padEnd(14)} ${percent(result.unknownRate).padStart(6)} (${result.functionsUnknown}/${result.functionsTotal})`,
    );
  }
  console.log(`   median-unknown-rate=${percent(medianUnknownRate)}`);
  console.log(
    `   unresolved-by-reason (all targets): ${[...reasonTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`)
      .join(", ")}`,
  );
}
