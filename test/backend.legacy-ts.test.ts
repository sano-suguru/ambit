import path from "node:path";
import { describe, expect, it } from "vitest";
import { installedPackageNameOf, type legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
import { extractFixture } from "./support/extract.ts";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "backend-smoke");

describe("legacyTsBackend.extractProject", () => {
  it("extracts every top-level function with its declared JSDoc tags", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
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
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#fetchRateDeclared");
    expect(fn?.jsDoc?.tags.get("effects")).toBe("network");
  });

  it("leaves jsDoc undefined when no tag is present", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#fetchRateUndeclared");
    expect(fn?.jsDoc).toBeUndefined();
  });

  it("reports a direct call to a global (fetch) with a qualified name for stub matching", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#fetchRateDeclared");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "fetch")).toBe(true);
  });

  it("resolves a call to another project-local function by SymbolId", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#calculateTaxViaDeclaredCallee");
    expect(fn?.calls.some((c) => c.resolvedCallee === "sample.ts#rateFromDeclared")).toBe(true);
  });

  it("marks a dynamic import() as unresolved", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsDynamicImport");
    expect(fn?.calls.some((c) => c.unresolvedReason === "dynamic-import")).toBe(true);
  });

  it("marks eval(...) as unresolved", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsEval");
    expect(fn?.calls.some((c) => c.unresolvedReason === "eval")).toBe(true);
  });

  it("marks a call to a callback parameter as unresolved (rule 4, deferred)", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsUnknownCallback");
    expect(fn?.calls.some((c) => c.unresolvedReason === "callback-parameter")).toBe(true);
  });

  it("produces 1-based line/col positions", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#calculateTax");
    expect(fn?.location.line).toBeGreaterThan(0);
    expect(fn?.location.col).toBeGreaterThan(0);
  });

  it("resolves a bare call to a named import via checker.getAliasedSymbol()", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsImportedFunction");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "helper.ts#helperPureFn" }),
    );
  });

  it("marks a builtin method reached through a local value as builtin-method", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsBuiltinMethod");
    expect(fn?.calls.some((c) => c.unresolvedReason === "builtin-method")).toBe(true);
  });

  it("marks a stub-miss call into an external package's .d.ts as external-module, alongside its qualified name", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsExternalModule");
    expect(
      fn?.calls.some(
        (c) =>
          c.unresolvedReason === "external-module" && c.calleeQualifiedName === "node:path.resolve",
      ),
    ).toBe(true);
  });

  it("counts function-like nodes it did not extract, by kind", async () => {
    const { skippedFunctions } = await extractFixture(FIXTURE_ROOT);
    expect(skippedFunctions.get("object-literal-method")).toBeGreaterThanOrEqual(1);
    expect(skippedFunctions.get("callback-argument")).toBeGreaterThanOrEqual(1);
    expect(skippedFunctions.get("nested-function")).toBeGreaterThanOrEqual(1);
    // Accessors and anonymous default exports are extracted now (DESIGN.md
    // §4.1 (a)), so they are no longer skipped — they have declaration paths
    // `ambit.config.ts` can name.
    expect(skippedFunctions.get("getter-setter")).toBeUndefined();
    expect(skippedFunctions.get("anonymous-default-export")).toBeUndefined();
  });

  it("indexes accessors and an anonymous default export under §4.1 (a)'s paths", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    // `get value` / `set value` share a name, so the accessor's kind is part
    // of the segment; the default export has no name at all and exactly one
    // per file, so `#default` is as stable as any identifier.
    expect(findFn(files, "skipped.ts#WithAccessors.get value")).toBeDefined();
    expect(findFn(files, "skipped.ts#WithAccessors.set value")).toBeDefined();
    expect(findFn(files, "skipped.ts#default")).toBeDefined();
  });

  it("still refuses a JSDoc contract on an accessor, naming the config key instead", async () => {
    // §4.1 (a) keeps the config namespace a superset of the JSDoc one: the
    // accessor propagates, but the comment on it is inert and must not be
    // adopted silently.
    const { files, uncarriedContracts } = await extractFixture(FIXTURE_ROOT);
    const accessor = findFn(files, "skipped.ts#WithAccessors.get value");
    expect(accessor?.configOnly).toBe(true);
    expect(accessor?.jsDoc).toBeUndefined();
    const reported = uncarriedContracts.find(
      (contract) => contract.configKey === "skipped.ts#WithAccessors.get value",
    );
    expect(reported).toMatchObject({ kind: "getter-setter", tag: "effects", raw: "fs_read" });
  });

  it("keeps counting object-literal members it cannot give a stable declaration path", async () => {
    const { files, skippedFunctions } = await extractFixture(FIXTURE_ROOT);
    // unindexable-literals.ts: computed, string and numeric keys have no
    // spelling that survives symbolId's "."-join; a nested literal and one
    // declared inside a function body have no declaration path at all.
    expect(skippedFunctions.get("object-literal-method")).toBeGreaterThanOrEqual(5);
    expect(findFn(files, "unindexable-literals.ts#computedKey.computed")).toBeUndefined();
    expect(findFn(files, "unindexable-literals.ts#nestedLiteral.inner")).toBeUndefined();
  });

  it("names an allowlisted builtin method called inline via checker.getFullyQualifiedName", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsPureBuiltinInline");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.map");
    expect(call).toBeDefined();
    expect(call?.callbackByReference).toBeUndefined();
  });

  it("follows a by-reference callback that names a function in the same tree (DESIGN.md §4.2 rule 4)", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsPureBuiltinByReference");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.map");
    // Not opaque: the argument is the answer to what the callback does, so the
    // call site carries an edge to it instead of falling to `unknown`.
    expect(call?.callbackByReference).toBeUndefined();
    expect(call?.callbackTargets).toEqual(["sample.ts#double"]);
  });

  it("marks a call as callbackByReference for an any-typed callback argument (getCallSignatures() is empty for any/unknown)", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#callsPureBuiltinByReferenceAnyTyped");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.map");
    expect(call?.callbackByReference).toBe(true);
  });

  it("does not mark a call as callbackByReference for a callable argument in a non-callback parameter slot (reduce's seed)", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "sample.ts#foldToThunk");
    const call = fn?.calls.find((c) => c.pureBuiltinName === "Array.reduce");
    expect(call).toBeDefined();
    expect(call?.callbackByReference).toBeUndefined();
  });

  it("resolves a call through an object-literal member whose body lives in the literal", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
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
    const { files } = await extractFixture(FIXTURE_ROOT);
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
    const { files } = await extractFixture(FIXTURE_ROOT);
    // `literalTypedByInterface: Dispatcher` makes the checker resolve `.run`
    // to Dispatcher's member signature. Following the value reaches the
    // literal anyway — this is the shape Ambit's own `legacyTsBackend` uses.
    const annotated = findFn(files, "call-resolution.ts#callsLiteralTypedByInterface");
    const bare = findFn(files, "call-resolution.ts#callsLiteralWithNamedFunction");
    expect(annotated?.calls.map((c) => c.resolvedCallee)).toEqual(
      bare?.calls.map((c) => c.resolvedCallee),
    );
  });

  it("resolves a class instance through its value, annotation or not (DESIGN.md §4.2 rule 7)", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    // `typedEngine: Runner` makes the checker resolve `.run` to Runner's
    // member signature, which no declaration path names. Following the value
    // reaches `Engine.run` anyway, and must give the bare binding's answer.
    const annotated = findFn(files, "call-resolution.ts#callsInstanceTypedByInterface");
    const bare = findFn(files, "call-resolution.ts#callsBareInstance");
    expect(bare?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "call-resolution.ts#Engine.run" }),
    );
    expect(annotated?.calls.map((c) => c.resolvedCallee)).toEqual(
      bare?.calls.map((c) => c.resolvedCallee),
    );
  });

  it("walks the extends chain to the method that actually runs", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    expect(findFn(files, "call-resolution.ts#callsInheritedInstanceMethod")?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "call-resolution.ts#Engine.run" }),
    );
  });

  it("leaves a call unresolved when no single object literal stands behind the receiver", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
    for (const caller of [
      // The receiver is a parameter: any object satisfying the type could
      // arrive at runtime.
      "callsInterfaceParam",
      "callsTypeAliasParam",
      // `let` may hold a different object by the time the call runs.
      "callsMutableLiteral",
      // A spread can override the member with something this walk cannot see.
      "callsSpreadLiteral",
      // The same two shapes on a class instance: a parameter is any object
      // satisfying the type, and a factory result is not a `new` this walk
      // can see. (A `let` is deliberately absent here: a class-typed binding
      // reaches the class's own member through the checker, before any
      // receiver rule runs, which is a different mechanism from this one.)
      "callsRunnerParam",
      "callsFactoryResult",
    ]) {
      const fn = findFn(files, `call-resolution.ts#${caller}`);
      expect(fn?.calls).toContainEqual(
        expect.objectContaining({ unresolvedReason: "unresolved-symbol" }),
      );
      expect(fn?.calls.every((c) => c.calleeQualifiedName === undefined)).toBe(true);
    }
  });

  it("lets an object-literal member carry its own @effects contract", async () => {
    const { files } = await extractFixture(FIXTURE_ROOT);
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
    const { files } = await extractFixture(FIXTURE_ROOT);
    const fn = findFn(files, "call-resolution.ts#callsClassInstanceMethod");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "call-resolution.ts#IndexedClass.method" }),
    );
  });

  it("counts a module-scope variable-bound arrow as extracted only, never also as skipped", async () => {
    const { files, skippedFunctions } = await extractFixture(FIXTURE_ROOT);
    // The map is keyed on the VariableDeclaration while the skip walk sees the
    // ArrowFunction, so this shape used to land in both tallies.
    expect(findFn(files, "call-resolution.ts#boundArrow")).toBeDefined();
    expect(skippedFunctions.get("other") ?? 0).toBe(0);
  });

  it("does not count an indexed (extracted) function as skipped", async () => {
    const { skippedFunctions } = await extractFixture(FIXTURE_ROOT);
    const totalSkipped = [...skippedFunctions.values()].reduce((a, b) => a + b, 0);
    // Every skip in the fixtures is deliberate (skipped.ts); if extracted
    // top-level functions leaked into this count, it would be much larger.
    expect(totalSkipped).toBeLessThan(20);
  });
});

describe("legacyTsBackend.extractProject (self-hosting)", () => {
  const SRC_ROOT = path.join(import.meta.dirname, "..", "src");

  it("resolves Ambit's own legacyTsBackend.extractProject call from analyze", async () => {
    // `legacyTsBackend: TsBackend = { extractProject }` makes the checker
    // resolve this callee to TsBackend's member signature in core/backend.ts,
    // so only following the receiver's value reaches the declared function.
    // Nothing smaller than a self-hosting assertion catches that.
    const { files } = await extractFixture(SRC_ROOT);
    const analyze = files
      .find((f) => f.filePath === "cli/analyze.ts")
      ?.functions.find((fn) => fn.id === "cli/analyze.ts#analyze");
    expect(analyze?.calls).toContainEqual(
      expect.objectContaining({
        resolvedCallee: "checker/backend/legacy-ts.ts#extractProject",
      }),
    );
  });

  it("classifies Ambit's own `calls.push(...)` as a local, non-escaping mutation", async () => {
    // `collectCalls` builds `const calls: CallSite[] = []` and pushes into it
    // from a nested `visit` closure — the exact shape DESIGN.md §4.2's
    // locality rule is meant to accept, and one no fixture produced: the push
    // is lexically inside a function nested in the summarized one. Before this
    // rule it was `Array.push`, the single most frequent unresolved name in
    // `check src --coverage`.
    const { files } = await extractFixture(SRC_ROOT);
    const collectCalls = files
      .find((f) => f.filePath === "checker/backend/legacy-ts.ts")
      ?.functions.find((fn) => fn.id === "checker/backend/legacy-ts.ts#collectCalls");
    expect(collectCalls?.calls).toContainEqual(
      expect.objectContaining({
        mutation: expect.objectContaining({ escaping: false, qualifiedName: "Array.push" }),
      }),
    );
    expect(collectCalls?.calls).not.toContainEqual(
      expect.objectContaining({ mutation: expect.objectContaining({ escaping: true }) }),
    );
  });

  it("follows Ambit's own `fn.calls.flatMap(toCalls)` to the function it names", async () => {
    // A by-reference callback whose target is reached through a same-file
    // declaration inside a nested arrow, on a `ReadonlyArray` receiver: the
    // shape `test/fixtures/builtins` cannot produce, because there the
    // referenced function is not also the one doing the referencing. Before
    // DESIGN.md §4.2 rule 4 was applied to the actual argument, this call was
    // the most frequent `ReadonlyArray.map` entry in `check src --coverage`.
    const { files } = await extractFixture(SRC_ROOT);
    const summarize = files
      .find((f) => f.filePath === "checker/summarize.ts")
      ?.functions.find((fn) => fn.id === "checker/summarize.ts#summarizeExtractedFiles");
    expect(summarize?.calls).toContainEqual(
      expect.objectContaining({
        pureBuiltinName: "ReadonlyArray.flatMap",
        callbackTargets: ["checker/summarize.ts#toCalls"],
      }),
    );
    expect(summarize?.calls).not.toContainEqual(
      expect.objectContaining({
        pureBuiltinName: "ReadonlyArray.flatMap",
        callbackByReference: true,
      }),
    );
  });

  it("names a call through a parameter from the package the type resolved through", async () => {
    // `checker.getSymbolAtLocation(...)` — the receiver is a parameter, so no
    // origin rule reaches it, and `typescript` is a real installed package
    // rather than a fixture's `declare module`. Only a self-hosting assertion
    // covers that half of the rule: every fixture declares its own types.
    const { files } = await extractFixture(SRC_ROOT);
    const named = files
      .find((f) => f.filePath === "checker/backend/legacy-ts.ts")
      ?.functions.find(
        (fn) => fn.id === "checker/backend/legacy-ts.ts#constructedClassQualifiedNameOf",
      );
    expect(named?.calls.map((c) => c.calleeQualifiedName)).toContain(
      "typescript.TypeChecker.getSymbolAtLocation",
    );
  });

  it("leaves a receiver `@types/node` declares unnamed", async () => {
    // `fs.statSync(root).isDirectory()` — `@types/node` writes its surface
    // inside `declare module "fs"`, so reading that ambient name would key
    // `fs.Stats.isDirectory` beside the `node:fs.*` rows the import specifier
    // already produces. The builtins have one spelling, not two.
    const { files } = await extractFixture(SRC_ROOT);
    const extract = files
      .find((f) => f.filePath === "checker/backend/legacy-ts.ts")
      ?.functions.find((fn) => fn.id === "checker/backend/legacy-ts.ts#extractProject");
    // Asserted against the call that is there, so a rename cannot make the
    // negative vacuously true.
    expect(extract?.calls.map((c) => c.calleeQualifiedName)).toContain("node:fs.statSync");
    expect(extract?.calls.some((c) => c.calleeQualifiedName?.startsWith("fs."))).toBe(false);
  });

  it("owns Ambit's own top-level `.then(...)` / `.catch(...)` callbacks", async () => {
    // `cli/main.ts` ends with `main(...).then(cb).catch(cb)` at module scope —
    // two function expressions in argument position with no extracted
    // ancestor, which is the shape DESIGN.md §4.1 (a)'s owner exists for.
    // Real code rather than a fixture, so the rule is asserted where it
    // actually has to hold.
    const { files } = await extractFixture(SRC_ROOT);
    const owner = files
      .find((f) => f.filePath === "cli/main.ts")
      ?.functions.find((fn) => fn.id === "cli/main.ts#<inline callbacks>");
    expect(owner?.undeclarable).toBe(true);
    expect(owner?.bodies).toHaveLength(2);
    expect(owner?.bodies?.flat()).toEqual(owner?.calls);
  });

  it("gives a file whose callbacks all have an extracted ancestor no owner", async () => {
    const { files } = await extractFixture(SRC_ROOT);
    const ids = files.flatMap((f) => f.functions.map((fn) => fn.id));
    // `checker/propagate.ts` is nothing but declarations, and its callbacks
    // are all inside one.
    expect(ids).not.toContain("checker/propagate.ts#<inline callbacks>");
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
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "direct-import.ts#pureCallsImportedNetwork");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "callee.ts#fetchRate" }),
    );
  });

  it("resolves a call imported through a barrel (index.ts) re-export to the original declaration", async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "barrel-import.ts#pureCallsBarrelImportedNetwork");
    expect(fn?.calls).toContainEqual(
      expect.objectContaining({ resolvedCallee: "callee.ts#fetchRate" }),
    );
  });

  it("qualifies a builtin re-exported through a barrel by the module that owns it, not by the barrel", async () => {
    // Without following the re-export chain this is
    // `./index.ts.readFileSync`, which no stub table can match — so a `pure`
    // function calling it reported `unknown` instead of `fs_read`.
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "barrel-builtin-import.ts#pureCallsBarrelImportedBuiltin");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "node:fs.readFileSync")).toBe(true);
  });

  it("follows a re-export chain more than one hop deep", async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "deep-barrel-import.ts#callsTwiceReExportedBuiltin");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "node:fs.readFileSync")).toBe(true);
  });

  it("classifies a named import of a builtin not in the stub table as external-module, qualified by module specifier", async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-named-import.ts#callsBuiltinNamedImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.unresolvedReason).toBe("external-module");
    expect(call?.calleeQualifiedName).toBe("node:fs.readdirSync");
  });

  it('qualifies a default import of a builtin by module specifier (e.g. `import fs from "node:fs"`)', async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-default-import.ts#callsBuiltinDefaultImport");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "node:fs.existsSync")).toBe(true);
  });

  it("qualifies an aliased named import of a builtin by its imported (not local) name (e.g. `import { readFileSync as rf }`)", async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "builtin-aliased-named-import.ts#callsBuiltinAliasedNamedImport");
    expect(fn?.calls.some((c) => c.calleeQualifiedName === "node:fs.readFileSync")).toBe(true);
  });

  it("classifies a named import from a nonexistent module as import-binding", async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "missing-module-import.ts#callsMissingModuleImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.unresolvedReason).toBe("import-binding");
  });

  it("still names a call through an unresolvable import binding for stub matching (import-binding is a fallback reason, not an early return)", async () => {
    const { files } = await extractFixture(CROSS_MODULE_ROOT);
    const fn = findFn(files, "missing-module-import.ts#callsMissingModuleImport");
    const call = fn?.calls.find((c) => !c.resolvedCallee);
    expect(call?.calleeQualifiedName).toBe("doesNotExist");
  });
});

describe("legacyTsBackend.extractProject (client receivers)", () => {
  const REALISTIC_ROOT = path.join(import.meta.dirname, "fixtures", "realistic-api");

  function callsOf(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    for (const file of files) {
      const fn = file.functions.find((f) => f.id === id);
      if (fn) return fn.calls;
    }
    return [];
  }

  it("names a method on a constructed client by module specifier and class, not by the local variable", async () => {
    // `const pool = new Pool(...)` with `Pool` imported from "pg": every part
    // of `pg.Pool.query` comes from the project's own source, so a locally
    // declared `declare module "pg"` and an installed `pg` produce the same key.
    const { files } = await extractFixture(REALISTIC_ROOT);
    const calls = callsOf(files, "src/lib/db.ts#insertOrder");
    expect(calls.some((c) => c.calleeQualifiedName === "pg.Pool.query")).toBe(true);
  });

  it("keeps the whole property path for a nested client member", async () => {
    const { files } = await extractFixture(REALISTIC_ROOT);
    expect(
      callsOf(files, "src/lib/db.ts#listUsers").some(
        (c) => c.calleeQualifiedName === "@prisma/client.PrismaClient.user.findMany",
      ),
    ).toBe(true);
    expect(
      callsOf(files, "src/lib/llm.ts#summarize").some(
        (c) => c.calleeQualifiedName === "openai.OpenAI.chat.completions.create",
      ),
    ).toBe(true);
  });

  it("resolves a client receiver imported through the barrel file", async () => {
    // The handler writes `pool.query(...)` with `pool` re-exported by
    // `src/lib/index.ts`; the name has to come from where the client was
    // actually constructed.
    const { files } = await extractFixture(REALISTIC_ROOT);
    expect(
      callsOf(files, "src/routes/orders.ts#listOrderTotals").some(
        (c) => c.calleeQualifiedName === "pg.Pool.query",
      ),
    ).toBe(true);
  });

  it("carries a literal string argument, and a template literal's static head", async () => {
    const { files } = await extractFixture(REALISTIC_ROOT);
    const query = callsOf(files, "src/lib/db.ts#insertOrder").find(
      (c) => c.calleeQualifiedName === "pg.Pool.query",
    );
    expect(query?.literalArguments?.[0]).toEqual({
      text: "INSERT INTO orders (customer_id, total_cents) VALUES ($1, $2)",
      complete: true,
    });

    const fetchCall = callsOf(files, "src/lib/rates.ts#fetchRate").find(
      (c) => c.calleeQualifiedName === "fetch",
    );
    expect(fetchCall?.literalArguments?.[0]).toEqual({
      text: "https://api.example.com/rates/",
      complete: false,
    });
  });

  it("classifies a call into the project's own .d.ts as ambient-declaration", async () => {
    // `response.json()` is declared in `types/globals.d.ts` — neither the
    // compiler's lib nor an installed package, so neither existing reason fits.
    const { files } = await extractFixture(REALISTIC_ROOT);
    const unresolved = callsOf(files, "src/lib/rates.ts#fetchRate").filter(
      (c) => !c.resolvedCallee && c.calleeQualifiedName === undefined,
    );
    expect(unresolved.map((c) => c.unresolvedReason)).toEqual(["ambient-declaration"]);
  });
});

describe("legacyTsBackend.extractProject (factory-created client receivers)", () => {
  const FACTORY_ROOT = path.join(import.meta.dirname, "fixtures", "factory-receiver");

  function callsOf(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    for (const file of files) {
      const fn = file.functions.find((f) => f.id === id);
      if (fn) return fn.calls;
    }
    return [];
  }

  function nameOf(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    return callsOf(files, id).map((c) => c.calleeQualifiedName);
  }

  it("names a method on a factory-created client by module specifier and returned type", async () => {
    // `const store = createStore()` — the specifier is what the source wrote,
    // the type name is what the declaration the call resolves to says it
    // returns. Neither comes from the local variable's spelling.
    const { files } = await extractFixture(FACTORY_ROOT);
    expect(nameOf(files, "named-import.ts#readsThroughNamedImportFactory")).toContain(
      "widget-store.Store.get",
    );
  });

  it("names it the same through every import shape the factory can arrive by", async () => {
    // Namespace, default, `as` alias, and a barrel re-export all name the same
    // client: the specifier is the module's, not the local spelling's.
    const { files } = await extractFixture(FACTORY_ROOT);
    for (const id of [
      "namespace-import.ts#readsThroughNamespaceImportFactory",
      "default-import.ts#readsThroughDefaultImportFactory",
      "aliased-import.ts#readsThroughAliasedFactory",
      "barrel-import.ts#readsThroughBarrelFactory",
    ]) {
      expect(nameOf(files, id)).toContain("widget-store.Store.get");
    }
  });

  it("names a factory-created client used from another module", async () => {
    // The client is constructed once at module scope and imported where it is
    // used — the shape `src/lib/db.ts`'s `pool` already has for `new`.
    const { files } = await extractFixture(FACTORY_ROOT);
    expect(nameOf(files, "imported-client.ts#readsThroughImportedClient")).toContain(
      "widget-store.Store.get",
    );
  });

  it("looks through an `await` on the factory call", async () => {
    const { files } = await extractFixture(FACTORY_ROOT);
    expect(nameOf(files, "awaited.ts#closesAwaitedHandle")).toContain("widget-store.Handle.close");
  });

  it("keeps a subpath specifier distinct from the package root", async () => {
    // `mysql2` and `mysql2/promise` are two entry points with two APIs; a name
    // that collapsed them would match the wrong table row.
    const { files } = await extractFixture(FACTORY_ROOT);
    expect(nameOf(files, "subpath-import.ts#readsThroughSubpathFactory")).toContain(
      "widget-store/sub.Store.get",
    );
  });

  it("names without resolving: a package no table covers stays unresolved", async () => {
    const { files } = await extractFixture(FACTORY_ROOT);
    const call = callsOf(files, "unlisted-package.ts#writesThroughUnlistedPackage").find(
      (c) => c.calleeQualifiedName === "widget-store.Store.put",
    );
    expect(call).toBeDefined();
    expect(call?.resolvedCallee).toBeUndefined();
    expect(call?.unresolvedReason).toBe("ambient-declaration");
  });

  it("names nothing when nothing the packages declare covers the receiver", async () => {
    const { files } = await extractFixture(FACTORY_ROOT);
    for (const id of [
      "anonymous-result.ts#callsAnonymousResult",
      "project-factory.ts#callsProjectFactoryResult",
    ]) {
      // Asserted against the call that is there, not against an empty list: a
      // mistyped id would make "no name" vacuously true.
      expect(callsOf(files, id)).toHaveLength(1);
      expect(nameOf(files, id)).toEqual([undefined]);
    }
  });

  it("falls back to the receiver's declared type where the factory rule names nothing", async () => {
    // A `let` binding and a project-local wrapper both defeat the factory
    // rule — one because the binding may be reassigned, the other because its
    // specifier is a path. Neither changes which package declares what the
    // receiver holds, and that is what names these two.
    const { files } = await extractFixture(FACTORY_ROOT);
    for (const id of [
      "mutable-binding.ts#readsThroughMutableBinding",
      "wrapper-client.ts#readsThroughProjectWrapper",
    ]) {
      expect(nameOf(files, id)).toEqual(["widget-store.Store.get"]);
    }
  });

  it("leaves a factory result the compiler's own lib declares on the pure-builtin path", async () => {
    // `createIndex(): Map<string, number>` — naming this `widget-store.Map`
    // would take `map.get(...)` off `src/stubs/pure-builtins.ts` and turn a
    // call proven effect-free into an unresolved one.
    const { files } = await extractFixture(FACTORY_ROOT);
    const call = callsOf(files, "default-lib-result.ts#readsThroughDefaultLibResult")[0];
    expect(call?.calleeQualifiedName).toBeUndefined();
    expect(call?.pureBuiltinName).toBe("Map.get");
  });
});

describe("legacyTsBackend.extractProject (receivers a package type names)", () => {
  const HELD_ROOT = path.join(import.meta.dirname, "fixtures", "held-receiver");

  function callsOf(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    for (const file of files) {
      const fn = file.functions.find((f) => f.id === id);
      if (fn) return fn.calls;
    }
    return [];
  }

  function nameOf(
    files: Awaited<ReturnType<typeof legacyTsBackend.extractProject>>["files"],
    id: string,
  ) {
    return callsOf(files, id).map((c) => c.calleeQualifiedName);
  }

  it("names a client held in a class field, injected, or passed as a parameter", async () => {
    // None of these is a binding the origin rules can follow, and all three
    // are the ordinary way server code holds a client. Before this rule every
    // one of them was unnamed, so no bundled table could fire on it.
    const { files } = await extractFixture(HELD_ROOT);
    for (const id of [
      "class-field.ts#FieldHolder.read",
      "injected.ts#InjectedHolder.read",
      "parameter.ts#readsThroughParameter",
    ]) {
      expect(nameOf(files, id)).toContain("widget-store.Client.read");
    }
  });

  it("names a call whose receiver is an earlier call in a fluent chain", async () => {
    // `client.table("widgets").where("stale").del()` — the receiver of `del`
    // is no binding at all, which is where a query builder puts every verb
    // that fixes the direction of the statement.
    const { files } = await extractFixture(HELD_ROOT);
    expect(nameOf(files, "fluent-chain.ts#ChainHolder.purge")).toEqual([
      "widget-store.Query.del",
      "widget-store.Query.where",
      "widget-store.Client.table",
    ]);
  });

  it("keys a delegate call on the client, not on the delegate's own type", async () => {
    // The root-most named receiver wins, so the key has the shape the client
    // table already uses for `@prisma/client.PrismaClient.user.findMany`.
    const { files } = await extractFixture(HELD_ROOT);
    expect(nameOf(files, "delegate.ts#DelegateHolder.list")).toContain(
      "widget-store.Hub.users.findMany",
    );
  });

  it("names nothing for a receiver the project's own source declares", async () => {
    // A project-local interface has no package to key on, and its
    // implementations are bodies DESIGN.md §4.2 rule 7 decides through the
    // receiver's value instead.
    const { files } = await extractFixture(HELD_ROOT);
    expect(callsOf(files, "project-interface.ts#readsThroughProjectInterface")).toHaveLength(1);
    expect(nameOf(files, "project-interface.ts#readsThroughProjectInterface")).toEqual([undefined]);
  });

  it("leaves a receiver the compiler's own lib declares on the pure-builtin path", async () => {
    // `hub.entries().get("k")` — naming this `widget-store.Map.get` would turn
    // a call proven effect-free into an unresolved one.
    const { files } = await extractFixture(HELD_ROOT);
    const call = callsOf(files, "default-lib-receiver.ts#readsDefaultLibResult").find(
      (c) => c.pureBuiltinName !== undefined,
    );
    expect(call?.calleeQualifiedName).toBeUndefined();
    expect(call?.pureBuiltinName).toBe("Map.get");
  });
});

describe("installedPackageNameOf", () => {
  it("names the package a declaration resolved through", () => {
    // The layout underneath never enters the name: a flat install, pnpm's
    // virtual store and a nested `node_modules` all answer `knex`.
    expect(installedPackageNameOf("/p/node_modules/knex/types/index.d.ts")).toBe("knex");
    expect(
      installedPackageNameOf("/p/node_modules/.pnpm/knex@3.3.0/node_modules/knex/types/index.d.ts"),
    ).toBe("knex");
    expect(installedPackageNameOf("/p/node_modules/a/node_modules/knex/index.d.ts")).toBe("knex");
    expect(installedPackageNameOf("/p/node_modules/@prisma/client/index.d.ts")).toBe(
      "@prisma/client",
    );
  });

  it("answers a `@types` package as the package it stands in for", () => {
    // A table keyed on `@types/pg.Pool.query` would match only the projects
    // whose `pg` happens to be untyped.
    expect(installedPackageNameOf("/p/node_modules/@types/pg/index.d.ts")).toBe("pg");
  });

  it("refuses `@types/node`", () => {
    // Node's builtins are already keyed from the import specifier
    // (`node:fs.readFileSync`); a second spelling would split the table.
    expect(installedPackageNameOf("/p/node_modules/@types/node/fs.d.ts")).toBeUndefined();
  });

  it("names nothing outside `node_modules`", () => {
    // A project's own `.d.ts`, and any resolver that does not lay packages
    // out under `node_modules` (Yarn PnP): no package to name, so none is
    // guessed at.
    expect(installedPackageNameOf("/p/src/types/globals.d.ts")).toBeUndefined();
    expect(installedPackageNameOf("/p/.yarn/cache/knex-npm-3.3.0.zip/knex/index.d.ts")).toBe(
      undefined,
    );
  });

  it("survives a Windows separator", () => {
    // `SourceFile.fileName` is normalized to forward slashes on every
    // platform; this asserts the parsing does not depend on that holding.
    expect(installedPackageNameOf("C:\\p\\node_modules\\knex\\types\\index.d.ts")).toBe("knex");
    expect(installedPackageNameOf("C:\\p\\node_modules\\@types\\node\\fs.d.ts")).toBeUndefined();
  });

  it("names nothing for a truncated path", () => {
    expect(installedPackageNameOf("/p/node_modules")).toBeUndefined();
    expect(installedPackageNameOf("/p/node_modules/@scope")).toBeUndefined();
  });
});
