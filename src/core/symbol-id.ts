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
