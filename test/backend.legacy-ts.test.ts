import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "backend-smoke");

describe("legacyTsBackend.extractProject", () => {
  it("extracts every top-level function with its declared JSDoc tags", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const sample = files.find((f) => f.filePath === "sample.ts");
    expect(sample).toBeDefined();

    const names = sample?.functions.map((f) => f.id).sort();
    expect(names).toContain("sample.ts#fetchRateDeclared");
    expect(names).toContain("sample.ts#calculateTax");
    expect(names).toContain("sample.ts#rateFromDeclared");
  });

  function findFn(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    for (const file of files) {
      const fn = file.functions.find((f) => f.id === id);
      if (fn) return fn;
    }
    return undefined;
  }

  it("reads the @effects JSDoc tag", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#fetchRateDeclared");
    expect(fn?.jsDoc?.tags.get("effects")).toBe("network");
  });

  it("leaves jsDoc undefined when no tag is present", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#fetchRateUndeclared");
    expect(fn?.jsDoc).toBeUndefined();
  });

  it("reports a direct call to a global (fetch) with a qualified name for stub matching", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#fetchRateDeclared");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "fetch")).toBe(true);
  });

  it("resolves a call to another project-local function by SymbolId", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#calculateTaxViaDeclaredCallee");
    expect(fn?.calls.some((c) => c.resolvedCallee === "sample.ts#rateFromDeclared")).toBe(true);
  });

  it("marks a dynamic import() as unresolved", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsDynamicImport");
    expect(fn?.calls.some((c) => c.unresolvedReason === "dynamic-import")).toBe(true);
  });

  it("marks eval(...) as unresolved", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsEval");
    expect(fn?.calls.some((c) => c.unresolvedReason === "eval")).toBe(true);
  });

  it("marks a call to a callback parameter as unresolved (rule 4, deferred)", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsUnknownCallback");
    expect(fn?.calls.some((c) => c.unresolvedReason === "callback-parameter")).toBe(true);
  });

  it("produces 1-based line/col positions", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#calculateTax");
    expect(fn?.location.line).toBeGreaterThan(0);
    expect(fn?.location.col).toBeGreaterThan(0);
  });

  it("resolves a bare call to a named import via checker.getAliasedSymbol()", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsImportedFunction");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "helper.ts#helperPureFn" }),
    );
  });

  it("marks a builtin method reached through a local value as builtin-method", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsBuiltinMethod");
    expect(fn?.calls.some((c) => c.unresolvedReason === "builtin-method")).toBe(true);
  });

  it("marks a stub-miss call into an external package's .d.ts as external-module, alongside its qualified name", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsExternalModule");
    expect(
      fn?.calls.some(
        (c) =>
          c.unresolvedReason === "external-module" && c.calleeQualifiedName === "node:path.resolve",
      ),
    ).toBe(true);
  });

  it("counts function-like nodes it did not extract, by kind", async () => {
    const { skippedFunctions } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    expect(skippedFunctions.get("getter-setter")).toBeGreaterThanOrEqual(2);
    expect(skippedFunctions.get("object-literal-method")).toBeGreaterThanOrEqual(1);
    expect(skippedFunctions.get("anonymous-default-export")).toBeGreaterThanOrEqual(1);
    expect(skippedFunctions.get("callback-argument")).toBeGreaterThanOrEqual(1);
    expect(skippedFunctions.get("nested-function")).toBeGreaterThanOrEqual(1);
  });

  it("classifies a PropertyAssignment-form object-literal method (`{ foo: () => 1 }`) the same as shorthand (`{ foo() {} }`)", async () => {
    const { skippedFunctions } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    // withMethod.method (shorthand) + withPropertyArrow.method (PropertyAssignment arrow)
    expect(skippedFunctions.get("object-literal-method")).toBeGreaterThanOrEqual(2);
  });

  it("names an allowlisted builtin method called inline via checker.getFullyQualifiedName", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsPureBuiltinInline");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.map");
    expect(call).toBeDefined();
    expect(call?.callbackByReference).toBeUndefined();
  });

  it("marks a call as callbackByReference when its callback is passed by reference, not written inline", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsPureBuiltinByReference");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.map");
    expect(call?.callbackByReference).toBe(true);
  });

  it("marks a call as callbackByReference for an any-typed callback argument (getCallSignatures() is empty for any/unknown)", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsPureBuiltinByReferenceAnyTyped");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.map");
    expect(call?.callbackByReference).toBe(true);
  });

  it("does not count an indexed (extracted) function as skipped", async () => {
    const { skippedFunctions } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const totalSkipped = [...skippedFunctions.values()].reduce((a, b) => a + b, 0);
    // Every skip in the fixtures is deliberate (skipped.ts); if extracted
    // top-level functions leaked into this count, it would be much larger.
    expect(totalSkipped).toBeLessThan(20);
  });
});

describe("legacyTsBackend.extractProject (cross-module alias resolution)", () => {
  const CROSS_MODULE_ROOT = path.join(import.meta.dirname, "fixtures", "cross-module");

  function findFn(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    for (const file of files) {
      const fn = file.functions.find((f) => f.id === id);
      if (fn) return fn;
    }
    return undefined;
  }

  it("resolves a call to a directly-imported project function, not just a same-file one", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "direct-import.ts#pureCallsImportedNetwork");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "callee.ts#fetchRate" }),
    );
  });

  it("resolves a call imported through a barrel (index.ts) re-export to the original declaration", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "barrel-import.ts#pureCallsBarrelImportedNetwork");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "callee.ts#fetchRate" }),
    );
  });

  it("classifies a named import of a builtin as external-module, not import-binding", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-named-import.ts#callsBuiltinNamedImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.unresolvedReason).toBe("external-module");
  });

  it("classifies a named import from a nonexistent module as import-binding", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "missing-module-import.ts#callsMissingModuleImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.unresolvedReason).toBe("import-binding");
  });

  it("still names a call through an unresolvable import binding for stub matching (import-binding is a fallback reason, not an early return)", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "missing-module-import.ts#callsMissingModuleImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.calleeQualifiedName).toBe("doesNotExist");
  });
});
