/**
 * Rendering a shadow report for a reader.
 *
 * The machine-readable half is the `ShadowReport` object itself, written as
 * JSON by `scripts/shadow-analysis.ts` for later corpus aggregation. This is
 * the other half: the block a person reads to decide whether anything here
 * needs looking at.
 *
 * Two things it must never do. It must not print a parity rate without the
 * counts behind it — a rate of 1.00 over nothing compared is the §3.4 failure
 * mode in a percentage. And it must not omit the high-risk count when it is
 * zero: an absent line reads as "not measured", and the whole point of
 * measuring the direction is to be able to say the dangerous one did not
 * happen.
 */

import type { ParityCount, ShadowReport } from "./compare.ts";

function rate(count: ParityCount): string {
  const compared = count.agreed + count.disagreed + count.authorityOnly + count.shadowOnly;
  const percent = (count.rate * 100).toFixed(1).padStart(5);
  return `${percent}%  ${String(count.agreed).padStart(6)}/${String(compared).padEnd(6)} (differ ${count.disagreed}, ts6-only ${count.authorityOnly}, ts7-only ${count.shadowOnly})`;
}

export function renderSummary(report: ShadowReport): string {
  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push(`# shadow analysis: ${report.root}`);
  push(
    `authority: ${report.authorityBackend.name}@${report.authorityBackend.version}   shadow: ${report.shadowBackend.name}@${report.shadowBackend.version}`,
  );
  push();

  if (report.errors.length > 0) {
    push(`## backend errors (${report.errors.length})`);
    for (const error of report.errors) push(`  ${error.backend} [${error.phase}] ${error.message}`);
    push();
  }

  push("## parity");
  const rows: readonly (readonly [string, ParityCount])[] = [
    ["functions", report.parity.functions],
    ["callee resolution", report.parity.calleeResolution],
    ["call-graph edges", report.parity.callEdges],
    ["unresolved class.", report.parity.unresolvedClassification],
    ["direct effects", report.parity.directEffects],
    ["propagated effects", report.parity.propagatedEffects],
    ["capabilities", report.parity.capabilities],
    ["authority (diff)", report.parity.authority],
    ["diagnostics", report.parity.diagnostics],
    ["runtime wrappers", report.parity.runtimeWrappers],
  ];
  for (const [label, count] of rows) push(`  ${label.padEnd(19)} ${rate(count)}`);
  push();

  push("## authority diff (ts6 as base, ts7 as head)");
  push(
    `  increases ${report.authorityDiff.increases}   decreases ${report.authorityDiff.decreases}   unknown gained ${report.authorityDiff.unknownGained}   unknown lost ${report.authorityDiff.unknownLost}`,
  );
  push();

  push("## decision");
  push(
    `  ts6 would ${report.decision.authorityWouldPass ? "pass" : "fail"}; ts7 would ${report.decision.shadowWouldPass ? "pass" : "fail"} — ${report.decision.agree ? "agree" : "DISAGREE"}`,
  );
  push();

  push("## unknown rate");
  push(
    `  ts6 ${(report.unknownRate.authority * 100).toFixed(1)}%   ts7 ${(report.unknownRate.shadow * 100).toFixed(1)}%   delta ${report.unknownRate.delta >= 0 ? "+" : ""}${(report.unknownRate.delta * 100).toFixed(1)} pt`,
  );
  push();

  push("## performance");
  push(
    `  ts6 ${report.timings.authorityMs.toFixed(0)} ms   ts7 ${report.timings.shadowMs.toFixed(0)} ms   ratio ${report.timings.ratio.toFixed(2)}x (below 1 = ts7 faster)`,
  );
  push();

  // Printed at zero as well: "0 high-risk divergences" is a measurement, an
  // absent line is not.
  push(`## divergences: ${report.divergences.length} (${report.highRiskCount} high-risk)`);
  const byClassification = new Map<string, number>();
  const byCategory = new Map<string, number>();
  for (const divergence of report.divergences) {
    byClassification.set(
      divergence.classification,
      (byClassification.get(divergence.classification) ?? 0) + 1,
    );
    byCategory.set(divergence.category, (byCategory.get(divergence.category) ?? 0) + 1);
  }
  if (byCategory.size > 0) {
    push("  by category:");
    for (const [category, count] of [...byCategory].toSorted((a, b) => b[1] - a[1])) {
      push(`    ${String(count).padStart(6)}  ${category}`);
    }
    push("  by classification:");
    for (const [classification, count] of [...byClassification].toSorted((a, b) => b[1] - a[1])) {
      push(`    ${String(count).padStart(6)}  ${classification}`);
    }
  }

  const highRisk = report.divergences.filter((divergence) => divergence.risk === "high");
  if (highRisk.length > 0) {
    push();
    push(`## high-risk divergences (first ${Math.min(20, highRisk.length)})`);
    for (const divergence of highRisk.slice(0, 20)) {
      push(
        `  [${divergence.category}/${divergence.direction}] ${divergence.symbol ?? ""} ${divergence.location ?? ""}`,
      );
      push(`      ts6: ${divergence.authorityValue ?? "(none)"}`);
      push(`      ts7: ${divergence.shadowValue ?? "(none)"}`);
      push(`      ${divergence.classification}${divergence.note ? ` — ${divergence.note}` : ""}`);
    }
  }

  if (report.notPorted.length > 0) {
    push();
    push("## not ported (a divergence here is a gap in the shadow backend, not a disagreement)");
    for (const shape of report.notPorted) push(`  ${shape}`);
  }

  return `${lines.join("\n")}\n`;
}
