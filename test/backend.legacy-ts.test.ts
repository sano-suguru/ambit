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

  it("keeps counting object-literal members it cannot give a stable declaration path", async () => {
    const { files, skippedFunctions } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    // unindexable-literals.ts: computed, string and numeric keys have no
    // spelling that survives symbolId's "."-join; a nested literal and one
    // declared inside a function body have no declaration path at all.
    expect(skippedFunctions.get("object-literal-method")).toBeGreaterThanOrEqual(5);
    expect(findFn(files, "unindexable-literals.ts#computedKey.computed")).toBeUndefined();
    expect(findFn(files, "unindexable-literals.ts#nestedLiteral.inner")).toBeUndefined();
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

  it("does not mark a call as callbackByReference for a callable argument in a non-callback parameter slot (reduce's seed)", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#foldToThunk");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.reduce");
    expect(call).toBeDefined();
    expect(call?.callbackByReference).toBeUndefined();
  });

  it("resolves a call through an object-literal member whose body lives in the literal", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    for (const [caller, callee] of [
      ["callsLiteralWithShorthandMethod", "literalWithShorthandMethod.run"],
      ["callsLiteralWithArrow", "literalWithArrow.run"],
      ["callsLiteralSatisfies", "literalSatisfies.run"],
    ] as const) {
      const fn = findFn(files, `call-resolution.ts#${caller}`);
      expect(fn?.calls).toContainEqual(
        expect.objectContaining({ resolvedCallee: `call-resolution.ts#${callee}` }),
      );
    }
  });

  it("resolves a call through an object-literal member that names an already-indexed function", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    for (const caller of [
      "callsLiteralWithNamedFunction",
      "callsLiteralWithShorthand",
      "callsLiteralTypedByInterface",
    ]) {
      const fn = findFn(files, `call-resolution.ts#${caller}`);
      // The property is an alias, not a declaration of its own: the call
      // resolves to the named function's existing id, and no second id is
      // minted for the same body.
      expect(fn?.calls).toContainEqual(
        expect.objectContaining({ resolvedCallee: "call-resolution.ts#indexedTarget" }),
      );
    }
  });

  it("resolves through the receiver's value, so a type annotation on the literal changes nothing", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    // `literalTypedByInterface: Dispatcher` makes the checker resolve `.run`
    // to Dispatcher's member signature. Following the value reaches the
    // literal anyway — this is the shape Ambit's own `legacyTsBackend` uses.
    const annotated = findFn(files, "call-resolution.ts#callsLiteralTypedByInterface");
    const bare = findFn(files, "call-resolution.ts#callsLiteralWithNamedFunction");
    expect(annotated?.calls.map((c) => c.resolvedCallee)).toEqual(
      bare?.calls.map((c) => c.resolvedCallee),
    );
  });

  it("leaves a call unresolved when no single object literal stands behind the receiver", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    for (const caller of [
      // The receiver is a parameter: any object satisfying the type could
      // arrive at runtime.
      "callsInterfaceParam",
      "callsTypeAliasParam",
      // `let` may hold a different object by the time the call runs.
      "callsMutableLiteral",
      // A spread can override the member with something this walk cannot see.
      "callsSpreadLiteral",
    ]) {
      const fn = findFn(files, `call-resolution.ts#${caller}`);
      expect(fn?.calls).toContainEqual(
        expect.objectContaining({ unresolvedReason: "unresolved-symbol" }),
      );
      expect(fn?.calls.every((c) => c.calleeQualifiedName === undefined)).toBe(true);
    }
  });

  it("lets an object-literal member carry its own @effects contract", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const member = findFn(files, "call-resolution.ts#literalWithDeclaredMethod.read");
    expect(member?.jsDoc?.tags.get("effects")).toBe("fs_read");

    const caller = findFn(files, "call-resolution.ts#callsLiteralDeclaredMethod");
    expect(caller?.calls).toContainEqual(
      expect.objectContaining({
        resolvedCallee: "call-resolution.ts#literalWithDeclaredMethod.read",
      }),
    );
  });

  it("resolves a call to a class instance method", async () => {
    const { files } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const fn = findFn(files, "call-resolution.ts#callsClassInstanceMethod");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "call-resolution.ts#IndexedClass.method" }),
    );
  });

  it("counts a module-scope variable-bound arrow as extracted only, never also as skipped", async () => {
    const { files, skippedFunctions } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    // The map is keyed on the VariableDeclaration while the skip walk sees the
    // ArrowFunction, so this shape used to land in both tallies.
    expect(findFn(files, "call-resolution.ts#boundArrow")).toBeDefined();
    expect(skippedFunctions.get("other") ?? 0).toBe(0);
  });

  it("does not count an indexed (extracted) function as skipped", async () => {
    const { skippedFunctions } = await legacyTsBackend.extractProject(FIXTURE_ROOT);
    const totalSkipped = [...skippedFunctions.values()].reduce((a, b) => a + b, 0);
    // Every skip in the fixtures is deliberate (skipped.ts); if extracted
    // top-level functions leaked into this count, it would be much larger.
    expect(totalSkipped).toBeLessThan(20);
  });
});

describe("legacyTsBackend.extractProject (self-hosting)", () => {
  const SRC_ROOT = path.join(import.meta.dirname, "..", "src");

  it("resolves Ambit's own legacyTsBackend.extractProject call from main", async () => {
    // `legacyTsBackend: TsBackend = { extractProject }` makes the checker
    // resolve this callee to TsBackend's member signature in core/backend.ts,
    // so only following the receiver's value reaches the declared function.
    // Nothing smaller than a self-hosting assertion catches that.
    const { files } = await legacyTsBackend.extractProject(SRC_ROOT);
    const main = files
      .find((f) => f.filePath === "cli/main.ts")
      ?.functions.find((fn) => fn.id === "cli/main.ts#main");
    expect(main?.calls).toContainEqual(
      expect.objectContaining({
        resolvedCallee: "checker/backend/legacy-ts.ts#extractProject",
      }),
    );
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

  it("classifies a named import of a builtin not in the stub table as external-module, qualified by module specifier", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-named-import.ts#callsBuiltinNamedImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.unresolvedReason).toBe("external-module");
    expect(call?.calleeQualifiedName).toBe("node:fs.readdirSync");
  });

  it('qualifies a default import of a builtin by module specifier (e.g. `import fs from "node:fs"`)', async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-default-import.ts#callsBuiltinDefaultImport");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "node:fs.existsSync")).toBe(true);
  });

  it("qualifies an aliased named import of a builtin by its imported (not local) name (e.g. `import { readFileSync as rf }`)", async () => {
    const { files } = await legacyTsBackend.extractProject(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-aliased-named-import.ts#callsBuiltinAliasedNamedImport");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "node:fs.readFileSync")).toBe(true);
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
