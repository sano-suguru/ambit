import path from "node:path";
import { describe, expect, it } from "vitest";
import type { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
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
