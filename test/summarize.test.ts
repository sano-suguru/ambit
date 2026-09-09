import { describe, expect, it } from "vitest";
import { parseEffectsTag, summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { ExtractedFile, SourceLocation } from "../src/core/index.ts";

const LOC: SourceLocation = { file: "f.ts", line: 1, col: 1, endLine: 1, endCol: 1 };

describe("parseEffectsTag", () => {
  it('parses "pure" as the empty effect set', () => {
    const set = parseEffectsTag("pure");
    expect(set).toBeDefined();
    expect(set?.effects.size).toBe(0);
    expect(set?.unknown).toBe(false);
  });

  it("parses a comma-separated list of known effects", () => {
    const set = parseEffectsTag("network, db_read");
    expect([...(set?.effects ?? [])].sort()).toEqual(["db_read", "network"]);
  });

  it("returns undefined for a tag containing an unrecognized token (rejected, not silently narrowed)", () => {
    expect(parseEffectsTag("network, not_a_real_effect")).toBeUndefined();
  });

  it("expands llm to include the implied network effect", () => {
    const set = parseEffectsTag("llm");
    expect([...(set?.effects ?? [])].sort()).toEqual(["llm", "network"]);
  });
});

describe("summarizeExtractedFiles", () => {
  it("treats a missing @effects tag as undeclared, not as declared-pure", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#undeclared" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.declared).toEqual({ kind: "none" });
  });

  it("treats a typo'd @effects tag as invalid, not as declared-pure", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#typoed" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: { tagLocations: new Map(), tags: new Map([["effects", "netwrok"]]) },
            calls: [],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.declared).toEqual({ kind: "invalid", raw: "netwrok" });
  });

  it("resolves a stub-matched call to a Call with kind 'stub'", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [{ location: LOC, calleeQualifiedName: "fetch" }],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      {
        kind: "stub",
        location: LOC,
        effects: ["network"],
        qualifiedName: "fetch",
        // A `fetch` whose URL the source does not fix has a target the runtime
        // will match and the checker cannot — that is not "requires nothing".
        capabilityTargetUnknown: true,
      },
    ]);
  });

  it("resolves a resolvable-import-qualified stub match (e.g. undici's fetch) to a Call with kind 'stub'", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [{ location: LOC, calleeQualifiedName: "undici.fetch" }],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      {
        kind: "stub",
        location: LOC,
        effects: ["network"],
        qualifiedName: "undici.fetch",
        capabilityTargetUnknown: true,
      },
    ]);
  });

  it("treats a named call with no stub match as unresolved, not as no-effect", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [{ location: LOC, calleeQualifiedName: "someThirdPartyLib.doThing" }],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      {
        kind: "unresolved",
        location: LOC,
        reason: "unresolved-symbol",
        qualifiedName: "someThirdPartyLib.doThing",
      },
    ]);
  });

  it("uses the connector layer's own reason over the generic fallback, when a stub-miss call already carries one", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [
              {
                location: LOC,
                calleeQualifiedName: "node:path.resolve",
                unresolvedReason: "external-module",
              },
            ],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      {
        kind: "unresolved",
        location: LOC,
        reason: "external-module",
        qualifiedName: "node:path.resolve",
      },
    ]);
  });

  it("resolves an allowlisted builtin method to a Call with kind 'known-pure'", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [{ location: LOC, pureBuiltinName: "Set.has" }],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      { kind: "known-pure", location: LOC, qualifiedName: "Set.has" },
    ]);
  });

  it("treats String.slice as known-pure, the twin of the already-listed Array.slice", () => {
    // Added to the allowlist after `check src --coverage` surfaced it 8 times;
    // non-mutating, and listing `Array.slice` without it was an accident.
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [{ location: LOC, pureBuiltinName: "String.slice" }],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      { kind: "known-pure", location: LOC, qualifiedName: "String.slice" },
    ]);
  });

  it("refuses known-pure for an allowlisted method whose callback is passed by reference", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [
              {
                location: LOC,
                pureBuiltinName: "Array.map",
                callbackByReference: true,
                unresolvedReason: "builtin-method",
              },
            ],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      { kind: "unresolved", location: LOC, reason: "builtin-method", qualifiedName: "Array.map" },
    ]);
  });

  it("treats an unlisted builtin method name as unresolved, not as pure", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [
              { location: LOC, pureBuiltinName: "Array.push", unresolvedReason: "builtin-method" },
            ],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([
      { kind: "unresolved", location: LOC, reason: "builtin-method", qualifiedName: "Array.push" },
    ]);
  });

  it("passes through a resolved call unchanged", () => {
    const files: ExtractedFile[] = [
      {
        runtimeWrappers: [],
        filePath: "f.ts",
        functions: [
          {
            id: "f.ts#fn" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: undefined,
            calls: [{ location: LOC, resolvedCallee: "f.ts#other" as never }],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.calls).toEqual([{ kind: "resolved", location: LOC, callee: "f.ts#other" }]);
  });
});

/**
 * DESIGN.md §4.4: a literal `withAmbit` / `ambitHandler` spec beside a handler
 * declared in the same file *is* that handler's `@capabilities` / `@budget`.
 * The tags stay legal, and stay in force when written — the spec is the last
 * side consulted, never an override.
 */
describe("summarizeExtractedFiles: a spec as the declaration (DESIGN.md §4.4)", () => {
  function fileWith(
    jsDocTags: readonly (readonly [string, string])[] | undefined,
    wrapper: ExtractedFile["runtimeWrappers"][number],
  ): ExtractedFile[] {
    return [
      {
        filePath: "f.ts",
        runtimeWrappers: [wrapper],
        functions: [
          {
            id: "f.ts#handler" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: jsDocTags
              ? { tagLocations: new Map(), tags: new Map(jsDocTags.map(([k, v]) => [k, v])) }
              : undefined,
            calls: [],
          },
        ],
      },
    ];
  }

  const SPEC: ExtractedFile["runtimeWrappers"][number] = {
    location: LOC,
    wrapper: "ambitHandler",
    capabilities: ["db:read:orders"],
    budget: { kind: "literal", timeMs: 500 },
    handler: "f.ts#handler" as never,
  };

  it("supplies @capabilities the JSDoc does not declare, recorded as declaredBy.capabilities", () => {
    const [summary] = summarizeExtractedFiles(fileWith([["entrypoint", ""]], SPEC));
    expect(summary?.capabilities).toEqual({
      kind: "declared",
      capabilities: {
        capabilities: [{ resource: "db", action: "read", target: "orders" }],
        unknown: false,
      },
    });
    expect(summary?.declaredBy?.capabilities).toBe("spec");
  });

  it("supplies @budget with onExceed defaulted, as a parsed tag already is", () => {
    const [summary] = summarizeExtractedFiles(fileWith([["entrypoint", ""]], SPEC));
    expect(summary?.budget).toEqual({
      kind: "declared",
      budget: { timeMs: 500, onExceed: "throw" },
    });
    expect(summary?.declaredBy?.budget).toBe("spec");
  });

  it("does not override a JSDoc tag: the written declaration stays in force", () => {
    const [summary] = summarizeExtractedFiles(
      fileWith(
        [
          ["entrypoint", ""],
          ["capabilities", "db:write:orders"],
          ["budget", "timeMs=800"],
        ],
        SPEC,
      ),
    );
    expect(summary?.capabilities).toEqual({
      kind: "declared",
      capabilities: {
        capabilities: [{ resource: "db", action: "write", target: "orders" }],
        unknown: false,
      },
    });
    expect(summary?.budget).toEqual({
      kind: "declared",
      budget: { timeMs: 800, onExceed: "throw" },
    });
    expect(summary?.declaredBy?.capabilities).toBe("jsdoc");
    expect(summary?.declaredBy?.budget).toBe("jsdoc");
  });

  it("does not stand in for a JSDoc tag that failed to parse", () => {
    const [summary] = summarizeExtractedFiles(
      fileWith(
        [
          ["entrypoint", ""],
          ["capabilities", "db:read"],
        ],
        SPEC,
      ),
    );
    expect(summary?.capabilities.kind).toBe("invalid");
    expect(summary?.declaredBy?.capabilities).toBeUndefined();
  });

  it("declares nothing from a half the source does not fix as a literal", () => {
    const [summary] = summarizeExtractedFiles(
      fileWith([["entrypoint", ""]], {
        location: LOC,
        wrapper: "ambitHandler",
        handler: "f.ts#handler" as never,
      }),
    );
    expect(summary?.capabilities).toEqual({ kind: "none" });
    expect(summary?.budget).toEqual({ kind: "none" });
    expect(summary?.declaredBy).toBeUndefined();
  });

  it("declares nothing for a handler the registration does not name", () => {
    const [summary] = summarizeExtractedFiles(
      fileWith([["entrypoint", ""]], {
        location: LOC,
        wrapper: "ambitHandler",
        capabilities: ["db:read:orders"],
        unmatchedReason: "handler-not-in-this-file",
      }),
    );
    expect(summary?.capabilities).toEqual({ kind: "none" });
  });

  it("lets the first registration naming a handler declare for it", () => {
    const files: ExtractedFile[] = [
      {
        filePath: "f.ts",
        runtimeWrappers: [
          SPEC,
          { ...SPEC, wrapper: "withAmbit", capabilities: ["db:write:orders"] },
        ],
        functions: [
          {
            id: "f.ts#handler" as never,
            location: LOC,
            declarationStart: LOC,
            jsDoc: { tagLocations: new Map(), tags: new Map([["entrypoint", ""]]) },
            calls: [],
          },
        ],
      },
    ];
    const [summary] = summarizeExtractedFiles(files);
    expect(summary?.capabilities).toEqual({
      kind: "declared",
      capabilities: {
        capabilities: [{ resource: "db", action: "read", target: "orders" }],
        unknown: false,
      },
    });
  });
});
