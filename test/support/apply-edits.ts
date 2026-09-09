import type { FixEdit } from "../../src/core/index.ts";

/**
 * Apply a diagnostic's `fixes[].edits` to a file's text, exactly as an agent
 * would. Ranges are 0-based, end-exclusive, in UTF-16 units (DESIGN.md §5.3);
 * applying them in reverse document order keeps earlier offsets valid.
 *
 * Deliberately dumb: if `fixes[].edits` needed anything cleverer than this to
 * apply, they would not be the "適用可能な具体的パッチ" §5.3 requires.
 */
export function applyEdits(source: string, edits: readonly FixEdit[]): string {
  const lines = source.split("\n");
  const ordered = [...edits].sort((a, b) => {
    const [[aLine, aCol]] = a.range;
    const [[bLine, bCol]] = b.range;
    return bLine - aLine || bCol - aCol;
  });

  for (const edit of ordered) {
    const [[startLine, startCol], [endLine, endCol]] = edit.range;
    if (startLine !== endLine) {
      throw new Error(`multi-line edit ranges are not supported by this helper: ${edit.file}`);
    }
    const line = lines[startLine];
    if (line === undefined) throw new Error(`edit points past end of file: ${edit.file}`);
    lines[startLine] = line.slice(0, startCol) + edit.replacement + line.slice(endCol);
  }
  return lines.join("\n");
}
