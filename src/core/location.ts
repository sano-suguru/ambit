/**
 * A source position, always relative to the project root that was passed to
 * `ambit check`. Never a compiler-internal position or snapshot offset
 * (DESIGN.md §5.3).
 *
 * `line`/`col` are 1-based (human-facing position); `endLine`/`endCol` mark
 * the end of the range, exclusive, also 1-based to match `line`/`col`.
 */
export interface SourceLocation {
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly endLine: number;
  readonly endCol: number;
}
