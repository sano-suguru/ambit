/**
 * A stable identifier for a function or method declaration.
 *
 * Built from the file path (relative to the project root passed to
 * `ambit check`) and a "."-joined declaration path (e.g. `["Foo",
 * "bar"]` for method `bar` on class `Foo`), joined with `#`
 * (`src/tax.ts#calculateTax`, matching the form used in DESIGN.md §5.1's
 * `contract.via[].symbol`).
 *
 * Never derived from a compiler-internal id or snapshot offset (DESIGN.md
 * §5.3), so it stays valid across re-analysis and across backends.
 */
export type SymbolId = string & { readonly __brand: "SymbolId" };

export function symbolId(relativeFilePath: string, declarationPath: readonly string[]): SymbolId {
  return `${relativeFilePath}#${declarationPath.join(".")}` as SymbolId;
}

/**
 * The short, human-facing name for a symbol id: the last segment of the
 * declaration path (`src/tax.ts#Foo.bar` → `bar`). Used by diagnostic
 * messages and by the CLI's human-readable rendering, which is why it lives
 * here rather than beside either one — DESIGN.md §5 makes the text output a
 * rendering of the structured diagnostic, so both sides must name a symbol
 * the same way.
 */
export function displayName(id: SymbolId): string {
  const afterHash = id.split("#")[1] ?? id;
  const parts = afterHash.split(".");
  const last = parts[parts.length - 1];
  if (last === undefined) return id;
  // A bare "constructor" names nothing — keep the class with it
  // (`Client.constructor`), since every class contributes one.
  if (last === "constructor" && parts.length >= 2) return `${parts[parts.length - 2]}.${last}`;
  return last;
}
