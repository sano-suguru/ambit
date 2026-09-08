import { describe, expect, it } from "vitest";
import { propagate, unknownWitnessChain, witnessChain } from "../src/checker/propagate.ts";
import type { FunctionSummary, SourceLocation, SymbolId } from "../src/core/index.ts";
import { effectSetOf, emptyEffectSet } from "../src/core/index.ts";

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
        calls: [{ kind: "stub", location: LOC, effect: "network", qualifiedName: "fetch" }],
      },
    ];
    const state = propagate(summaries);
    expect([...state.get(id("f.ts#pureCallsFetch"))!.observed.effects]).toEqual(["network"]);
  });

  it("rule 1: propagates a declared callee's DECLARED effects, not its own body (trust boundary)", () => {
    const summaries: FunctionSummary[] = [
      {
        id: id("f.ts#fetchRate"),
        location: LOC,
        declared: { kind: "declared", effects: effectSetOf("network") },
        calls: [{ kind: "stub", location: LOC, effect: "network", qualifiedName: "fetch" }],
      },
      {
        id: id("f.ts#calculateTax"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
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
        calls: [{ kind: "stub", location: LOC, effect: "network", qualifiedName: "fetch" }],
      },
      {
        id: id("f.ts#calculateTax"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
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
        calls: [
          { kind: "stub", location: LOC, effect: "network", qualifiedName: "fetch" },
          { kind: "unresolved", location: LOC, reason: "any-typed" },
        ],
      },
      {
        id: id("f.ts#calculateTax"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
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
        calls: [{ kind: "unresolved", location: LOC, reason: "eval" }],
      },
      {
        id: id("f.ts#pureReachesUnknown"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
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
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#a") }],
      },
      {
        id: id("f.ts#a"),
        location: LOC,
        declared: { kind: "none" },
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#b") }],
      },
      {
        id: id("f.ts#b"),
        location: LOC,
        declared: { kind: "none" },
        calls: [
          { kind: "stub", location: LOC, effect: "network", qualifiedName: "fetch" },
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
        calls: [
          {
            kind: "stub",
            location: LOC,
            effect: "llm",
            qualifiedName: "anthropic.messages.create",
          },
        ],
      },
      {
        id: id("f.ts#pureCaller"),
        location: LOC,
        declared: { kind: "declared", effects: emptyEffectSet() },
        calls: [{ kind: "resolved", location: LOC, callee: id("f.ts#callLlm") }],
      },
    ];
    const state = propagate(summaries);
    const observed = state.get(id("f.ts#pureCaller"))!.observed;
    expect(observed.effects.has("llm")).toBe(true);
    expect(observed.effects.has("network")).toBe(true);
  });
});
