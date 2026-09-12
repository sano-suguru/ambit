import type { AnalysisResult } from "../../src/checker/index.ts";

/**
 * The whole externally observable result of one analysis, as bytes.
 *
 * DESIGN.md §6.2's equivalence law is stated in bytes — "the same diagnostics,
 * the same `kind: \"authority\"` records, the same coverage counts, in the same
 * order" — so the differential suite compares this string and never
 * `expect(a).toEqual(b)` on the objects. `toEqual` on a `Map` ignores insertion
 * order, and insertion order is exactly what `ambit check --coverage --format
 * json` serializes through `Object.fromEntries`.
 *
 * It lives here rather than inside the test file because one comparison in that
 * suite runs its cold oracle in a **separate process** (`cold-oracle.ts`), and
 * the two sides have to render identically or the comparison is measuring the
 * renderer.
 */
export function renderAnalysis(analysis: AnalysisResult): string {
  const lines = [
    ...analysis.diagnostics.map((diagnostic) => JSON.stringify(diagnostic)),
    ...analysis.authority.map((record) => JSON.stringify(record)),
    JSON.stringify({
      ...analysis.coverage,
      // `JSON.stringify` writes a `Map` as `{}`. Written as entry lists so the
      // comparison sees the counts *and* their order.
      skippedByKind: [...analysis.coverage.skippedByKind],
      unresolvedByReason: [...analysis.coverage.unresolvedByReason],
    }),
  ];
  return `${lines.join("\n")}\n`;
}
