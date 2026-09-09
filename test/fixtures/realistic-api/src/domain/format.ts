/** Presentation helpers. Nothing here touches the outside world. */

/** @effects pure */
export function formatCurrency(cents: number, symbol: string): string {
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** @effects pure */
export function padLeft(text: string, width: number, filler: string): string {
  let padded = text;
  while (padded.length < width) padded = filler + padded;
  return padded;
}

/** @effects pure */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** @effects pure */
export function titleCase(text: string): string {
  return text.length === 0 ? text : text[0]?.toUpperCase() + text.slice(1).toLowerCase();
}

/** @effects pure */
export function joinNonEmpty(parts: readonly string[], separator: string): string {
  return parts.filter((part) => part.length > 0).join(separator);
}

/** @effects pure */
export function percentage(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/** @effects pure */
export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

/** @effects pure */
export function summaryLine(label: string, cents: number): string {
  return joinNonEmpty([titleCase(label), formatCurrency(cents, "$")], ": ");
}
