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
      { kind: "stub", location: LOC, effect: "network", qualifiedName: "fetch" },
    ]);
  });

  it("resolves a resolvable-import-qualified stub match (e.g. undici's fetch) to a Call with kind 'stub'", () => {
    const files: ExtractedFile[] = [
      {
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
      { kind: "stub", location: LOC, effect: "network", qualifiedName: "undici.fetch" },
    ]);
  });

  it("treats a named call with no stub match as unresolved, not as no-effect", () => {
    const files: ExtractedFile[] = [
      {
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

  it("refuses known-pure for an allowlisted method whose callback is passed by reference", () => {
    const files: ExtractedFile[] = [
      {
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
