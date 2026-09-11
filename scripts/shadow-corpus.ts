/**
 * The shadow comparison over real third-party TypeScript.
 *
 *     node scripts/shadow-corpus.ts            # every corpus target
 *     node scripts/shadow-corpus.ts hono got   # named targets only
 *
 * `src` is a poor witness for the ecosystem: one coding style, one set of
 * dependencies, one tsconfig, one module pattern, and the very shapes the
 * shadow backend was written against. 99.x% parity there is *self-hosting*
 * parity, and only ecosystem parity says anything about adoption — which is
 * the reason `docs/measurements/2026-09-12-ts7-shadow-analysis.md` put this
 * ahead of tidy-up work.
 *
 * The corpus is `test/corpus/corpus.json`, the same fixed, doubly-pinned set
 * `scripts/bench-corpus.ts` measures against — by commit SHA and by the git
 * tree object of each measured subtree, so a drifted checkout fails loudly
 * rather than quietly moving a number. Dependencies are deliberately not
 * installed, which moves every measurement in the conservative direction only.
 *
 * It fetches from the network, so like `bench-corpus.ts` it is **not** in
 * `pnpm test` and not in any CI job. `scripts/shadow-check.ts` is the gate;
 * this is the reading that tells you what the gate should be watching.
 *
 * Exit codes are about the run, not the parity: 0 when every requested target
 * was compared, 2 when one could not be.
 */

import process from "node:process";
import { ensureCorpus } from "./corpus.ts";
import type { Divergence } from "./shadow/compare.ts";
import { NOT_PORTED, nativeTs7Backend } from "./shadow/native-ts7-backend.ts";
import { compareRoot } from "./shadow/run-root.ts";

/** A divergence's shape, coarse enough that repeats of one gap collapse into one row. */
function shapeOf(divergence: Divergence): string {
  return `${divergence.category}/${divergence.direction}`;
}

async function main(): Promise<number> {
  if (!nativeTs7Backend.version) {
    process.stderr.write(
      "the native compiler reported no version.\nRun: node scripts/m05-native-install.ts\n",
    );
    return 2;
  }

  const requested = process.argv.slice(2).filter((argument) => !argument.startsWith("--"));
  const targets = ensureCorpus().filter(
    (target) => requested.length === 0 || requested.includes(target.name),
  );
  if (targets.length === 0) {
    process.stderr.write(`no corpus target matched ${requested.join(", ")}\n`);
    return 2;
  }

  const known = new Map<string, number>();
  const novel = new Map<string, number>();
  let failed = false;

  for (const target of targets) {
    const { report, errors } = await compareRoot(target.dir, false);
    if (!report) {
      for (const error of errors) {
        process.stderr.write(
          `${target.name}: ${error.backend} failed during ${error.phase}: ${error.message}\n`,
        );
      }
      failed = true;
      continue;
    }

    const counts = new Map<string, { total: number; highRisk: number; classified: number }>();
    for (const divergence of report.divergences) {
      const shape = shapeOf(divergence);
      const row = counts.get(shape) ?? { total: 0, highRisk: 0, classified: 0 };
      row.total++;
      if (divergence.risk === "high") row.highRisk++;
      if (divergence.classification !== "unclassified") row.classified++;
      counts.set(shape, row);
      // "Known" means the shadow backend itself said why — a NOT_PORTED code
      // it reported at that site. Everything else is a shape this comparison
      // has not accounted for, and those are the rows worth reading.
      const bucket = divergence.classification === "unclassified" ? novel : known;
      bucket.set(shape, (bucket.get(shape) ?? 0) + 1);
    }

    process.stdout.write(`\n## ${target.name} — ${target.what}\n`);
    process.stdout.write(
      `  ${target.repo} @ ${target.commit.slice(0, 10)} (${target.subdir}, tree ${target.observedTree.slice(0, 10)})\n`,
    );
    process.stdout.write(
      `  functions ${(100 * report.parity.functions.rate).toFixed(1)}%  callee resolution ${(100 * report.parity.calleeResolution.rate).toFixed(1)}%  direct effects ${(100 * report.parity.directEffects.rate).toFixed(1)}%  authority ${(100 * report.parity.authority.rate).toFixed(1)}%\n`,
    );
    process.stdout.write(
      `  authority diff: increases ${report.authorityDiff.increases}  decreases ${report.authorityDiff.decreases}  unknown gained ${report.authorityDiff.unknownGained}  unknown lost ${report.authorityDiff.unknownLost}\n`,
    );
    process.stdout.write(
      `  unknown rate: ts6 ${(100 * report.unknownRate.authority).toFixed(1)}%  ts7 ${(100 * report.unknownRate.shadow).toFixed(1)}%  delta ${(100 * report.unknownRate.delta).toFixed(1)} pt\n`,
    );
    process.stdout.write(
      `  decision: ts6 would ${report.decision.authorityWouldPass ? "pass" : "fail"}; ts7 would ${report.decision.shadowWouldPass ? "pass" : "fail"} — ${report.decision.agree ? "agree" : "DISAGREE"}\n`,
    );
    process.stdout.write(
      `  divergences ${report.divergences.length} (${report.highRiskCount} high-risk)  ts6 ${Math.round(report.timings.authorityMs)} ms / ts7 ${Math.round(report.timings.shadowMs)} ms = ${report.timings.ratio.toFixed(2)}x\n`,
    );
    for (const [shape, row] of [...counts].toSorted((a, b) => b[1].total - a[1].total)) {
      process.stdout.write(
        `      ${String(row.total).padStart(5)}  ${shape.padEnd(42)} high-risk ${String(row.highRisk).padStart(4)}  classified ${row.classified}/${row.total}\n`,
      );
    }
  }

  process.stdout.write("\n## across the corpus\n");
  process.stdout.write("  shapes the shadow backend itself accounted for:\n");
  for (const [shape, count] of [...known].toSorted((a, b) => b[1] - a[1])) {
    process.stdout.write(`      ${String(count).padStart(5)}  ${shape}\n`);
  }
  process.stdout.write("  shapes nothing accounted for — these are the findings:\n");
  if (novel.size === 0) process.stdout.write("      (none)\n");
  for (const [shape, count] of [...novel].toSorted((a, b) => b[1] - a[1])) {
    process.stdout.write(`      ${String(count).padStart(5)}  ${shape}\n`);
  }
  process.stdout.write(`\n  not ported: ${NOT_PORTED.join(", ")}\n`);
  return failed ? 2 : 0;
}

process.exitCode = await main();
