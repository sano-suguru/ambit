import { describe, expect, it } from "vitest";
import { diagnose } from "../src/checker/diagnose.ts";
import type { PropagatedFunction } from "../src/checker/propagate.ts";
import { propagate, unknownWitnessChain, witnessChain } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type {
  ExtractedFile,
  FunctionSummary,
  SourceLocation,
  SymbolId,
} from "../src/core/index.ts";
import { effectSetOf, emptyEffectSet, formatCapability } from "../src/core/index.ts";
import { NO_OTHER_CONTRACTS } from "./support/summary.ts";

const LOC: SourceLocation = { file: "f.ts", line: 1, col: 1, endLine: 1, endCol: 1 };

function id(s: string): SymbolId {
  return s as SymbolId;
}

describe("propagate", () => {
  it("rule 2: a pure function's own direct stub call is its observed effect", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#pureCallsFetch"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "stub", location: LOC, effects: ["network"], qualifiedName: "fetch" }],
      },
    ];
    const state = propagate(summaries);
    expect([...state.get(id("f.ts#pureCallsFetch"))!.observed.effects]).toEqual(["network"]);
  });

  it("a known-pure builtin call contributes no effect and does not set unknown", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#usesSetHas"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "known-pure", location: LOC, qualifiedName: "Set.has" }],
      },
    ];
    const state = propagate(summaries);
    const observed = state.get(id("f.ts#usesSetHas"))!.observed;
    expect(observed.effects.size).toBe(0);
    expect(observed.unknown).toBe(false);
  });

  it("rule 1: propagates a declared callee's DECLARED effects, not its own body (trust boundary)", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#fetchRate"),
        location: LOC,
        declared: { kind: "declared", effects: effectSetOf("network") },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "stub", location: LOC, effects: ["network"], qualifiedName: "fetch" }],
      },
      {
        id: id("f.ts#calculateTax"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#fetchRate") }],
      },
    ];
    const state = propagate(summaries);
    const caller = state.get(id("f.ts#calculateTax"))!;
    expect([...caller.observed.effects]).toEqual(["network"]);

    const chain = witnessChain(id("f.ts#calculateTax"), "network", state);
    expect(chain).toEqual([id("f.ts#fetchRate")]);
  });

  it("rule 1: propagates an undeclared callee's inferred effects transitively", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#fetchRateUndeclared"),
        location: LOC,
        declared: { kind: "none" },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "stub", location: LOC, effects: ["network"], qualifiedName: "fetch" }],
      },
      {
        id: id("f.ts#calculateTax"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#fetchRateUndeclared") }],
      },
    ];
    const state = propagate(summaries);
    expect([...state.get(id("f.ts#calculateTax"))!.observed.effects]).toEqual(["network"]);
  });

  it("a declared callee's own undeclared unknown does not leak to its callers", () => {
    const summaries: FunctionSummary[] = [
      {
        // Declares network, but its own body also reaches an unresolved
        // call — that mismatch is fetchRate's own problem (would surface
        // via diagnose.ts against fetchRate itself), not its callers'.
        id: id("f.ts#fetchRate"),
        location: LOC,
        declared: { kind: "declared", effects: effectSetOf("network") },
        ...NO_OTHER_CONTRACTS,
        calls: [
          { kind: "stub", location: LOC, effects: ["network"], qualifiedName: "fetch" },
          { kind: "unresolved", location: LOC, reason: "any-typed" },
        ],
      },
      {
        id: id("f.ts#calculateTax"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#fetchRate") }],
      },
    ];
    const state = propagate(summaries);
    const caller = state.get(id("f.ts#calculateTax"))!;
    expect(caller.observed.unknown).toBe(false);
    expect([...caller.observed.effects]).toEqual(["network"]);
  });

  it("rule 3: unknown propagates from an undeclared callee's unresolved call", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#callsUnresolved"),
        location: LOC,
        declared: { kind: "none" },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "unresolved", location: LOC, reason: "eval" }],
      },
      {
        id: id("f.ts#pureReachesUnknown"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#callsUnresolved") }],
      },
    ];
    const state = propagate(summaries);
    const caller = state.get(id("f.ts#pureReachesUnknown"))!;
    expect(caller.observed.unknown).toBe(true);
    expect(unknownWitnessChain(id("f.ts#pureReachesUnknown"), state)).toEqual([
      id("f.ts#callsUnresolved"),
    ]);
  });

  it("converges on mutual recursion (cycle) without looping forever", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#entry"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#a") }],
      },
      {
        id: id("f.ts#a"),
        location: LOC,
        declared: { kind: "none" },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#b") }],
      },
      {
        id: id("f.ts#b"),
        location: LOC,
        declared: { kind: "none" },
        ...NO_OTHER_CONTRACTS,
        calls: [
          { kind: "stub", location: LOC, effects: ["network"], qualifiedName: "fetch" },
          { kind: "resolved", location: LOC, callee: id("f.ts#a") },
        ],
      },
    ];
    const state = propagate(summaries);
    expect([...state.get(id("f.ts#entry"))!.observed.effects]).toEqual(["network"]);
    expect(witnessChain(id("f.ts#entry"), "network", state)).toEqual([id("f.ts#a"), id("f.ts#b")]);
  });

  it("llm implies network across propagation", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#callLlm"),
        location: LOC,
        declared: { kind: "none" },
        ...NO_OTHER_CONTRACTS,
        calls: [
          {
            kind: "stub",
            location: LOC,
            effects: ["llm"],
            qualifiedName: "anthropic.messages.create",
          },
        ],
      },
      {
        id: id("f.ts#pureCaller"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        ...NO_OTHER_CONTRACTS,
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#callLlm") }],
      },
    ];
    const state = propagate(summaries);
    const observed = state.get(id("f.ts#pureCaller"))!.observed;
    expect(observed.effects.has("llm")).toBe(true);
    expect(observed.effects.has("network")).toBe(true);
  });
});

/**
 * DESIGN.md §4.4: a capability declaration is a trust boundary — a caller
 * inherits what a declaring callee *declares*, not what its body turns out to
 * need, and may only narrow from there. A declaration a literal spec supplied
 * is that same declaration; nothing in propagation knows or cares which side
 * of the source wrote it.
 */
describe("propagate: a capability set the spec declared (DESIGN.md §4.4)", () => {
  function project(callerCapabilities: string): ReadonlyMap<SymbolId, PropagatedFunction> {
    const files: ExtractedFile[] = [
      {
        filePath: "f.ts",
        runtimeWrappers: [
          {
            location: LOC,
            wrapper: "ambitHandler",
            capabilities: ["db:read:orders"],
            handler: id("f.ts#handler"),
          },
        ],
        functions: [
          {
            id: id("f.ts#handler"),
            location: LOC,
            declarationStart: LOC,
            jsDoc: {
              tagLocations: new Map(),
              tags: new Map([
                ["entrypoint", ""],
                ["effects", "db_read"],
              ]),
            },
            // An unresolved call: the body alone would leave the requirement
            // unknown, and does not, because the spec declared it.
            calls: [{ location: LOC, calleeQualifiedName: "third-party.doThing" }],
          },
          {
            id: id("f.ts#caller"),
            location: LOC,
            declarationStart: LOC,
            jsDoc: {
              tagLocations: new Map(),
              tags: new Map([
                ["capabilities", callerCapabilities],
                ["effects", "db_read"],
              ]),
            },
            calls: [{ location: LOC, resolvedCallee: id("f.ts#handler") }],
          },
        ],
      },
    ];
    return propagate(summarizeExtractedFiles(files));
  }

  it('reaches propagation as capabilities.kind === "declared"', () => {
    const state = project("db:read:orders");
    const handler = state.get(id("f.ts#handler"))!;
    expect(handler.summary.capabilities).toEqual({
      kind: "declared",
      capabilities: {
        capabilities: [{ resource: "db", action: "read", target: "orders" }],
        unknown: false,
      },
    });
    // Nothing else about the handler changed: the unresolved call in its body
    // still leaves its effects unknown, which is its own AMB-W001.
    expect(handler.observed.unknown).toBe(true);
  });

  it("propagates to a caller as a declared callee's contribution", () => {
    const state = project("db:read:orders");
    const caller = state.get(id("f.ts#caller"))!;
    expect(caller.required.capabilities.map(formatCapability)).toEqual(["db:read:orders"]);
    expect(caller.required.unknown).toBe(false);
  });

  it("narrows only: a caller granting less than the spec declared is AMB-E005", () => {
    const state = project("db:read:public");
    const escalation = diagnose(state, { name: "test", version: "0" }).filter(
      (d) => d.id === "AMB-E005" && d.message.startsWith("caller "),
    );
    expect(escalation).toHaveLength(1);
    const contract = escalation[0]?.contract;
    expect(contract && "excess" in contract ? contract.excess : undefined).toEqual([
      "db:read:orders",
    ]);
    expect(escalation[0]?.severity).toBe("error");
  });
});
