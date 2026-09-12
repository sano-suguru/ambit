import { describe, expect, it } from "vitest";
import { changedSymbols, impactClosure, summariesEqual } from "../src/checker/index.ts";
import type { Call, FunctionSummary, SymbolId } from "../src/core/index.ts";

/**
 * Phase 3's changed set and impact set, as pure functions
 * (`docs/resident-check-path.md`, "Impact and the fixed point").
 *
 * The differential suite proves the *result* of using them is equal to a cold
 * run. These tests are the other half: they pin the decisions themselves, one
 * field at a time, so a comparator that has quietly narrowed is caught here
 * with a name rather than as one byte of difference three layers away.
 *
 * **A row asserting `true` is the dangerous direction.** Equal means "reuse
 * the committed propagated value", so every `toBe(true)` here is a claim that
 * the difference shown cannot change what propagates, and every `toBe(false)`
 * is a claim the comparator is conservative enough. The `false` rows are the
 * ones that would go stale silently.
 */

const AT = { file: "a.ts", line: 1, col: 1, endLine: 3, endCol: 2 } as const;
const ELSEWHERE = { file: "a.ts", line: 9, col: 1, endLine: 11, endCol: 2 } as const;

function summary(overrides: Partial<FunctionSummary> = {}): FunctionSummary {
  return {
    id: "a.ts#f" as SymbolId,
    location: AT,
    tagLocations: new Map(),
    declarationStart: AT,
    declared: { kind: "none" },
    capabilities: { kind: "none" },
    budget: { kind: "none" },
    boundary: { kind: "none" },
    entrypoint: false,
    calls: [],
    ...overrides,
  };
}

const RESOLVED: Call = { kind: "resolved", location: AT, callee: "a.ts#g" as SymbolId };
const STUB: Call = {
  kind: "stub",
  location: AT,
  effects: ["network"],
  qualifiedName: "fetch",
};

describe("summariesEqual", () => {
  it("holds for a summary rebuilt field for field from a different object", () => {
    expect(summariesEqual(summary(), summary())).toBe(true);
    expect(
      summariesEqual(summary({ calls: [RESOLVED, STUB] }), summary({ calls: [RESOLVED, STUB] })),
    ).toBe(true);
  });

  it("separates every contract tag, including a tag that was present but did not parse", () => {
    const declared = summary({
      declared: { kind: "declared", effects: { effects: new Set(["network"]), unknown: false } },
    });
    expect(summariesEqual(summary(), declared)).toBe(false);
    // `none` and `invalid` are treated alike in propagation and are *not* the
    // same summary: one is a coverage fact, the other is AMB-E002.
    expect(
      summariesEqual(summary(), summary({ declared: { kind: "invalid", raw: "netwrok" } })),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ declared: { kind: "invalid", raw: "netwrok" } }),
        summary({ declared: { kind: "invalid", raw: "netwrk" } }),
      ),
    ).toBe(false);
    expect(summariesEqual(summary(), summary({ entrypoint: true }))).toBe(false);
    expect(
      summariesEqual(summary(), summary({ boundary: { kind: "declared", reason: "vendor" } })),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ boundary: { kind: "declared", reason: "vendor" } }),
        summary({ boundary: { kind: "declared", reason: "other" } }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ budget: { kind: "declared", budget: { timeMs: 10, onExceed: "throw" } } }),
        summary({ budget: { kind: "declared", budget: { timeMs: 20, onExceed: "throw" } } }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ budget: { kind: "declared", budget: { timeMs: 10, onExceed: "throw" } } }),
        summary({ budget: { kind: "declared", budget: { timeMs: 10, onExceed: "warn" } } }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({
          capabilities: {
            kind: "declared",
            capabilities: {
              capabilities: [{ resource: "http", action: "get", target: "a.example.com" }],
              unknown: false,
            },
          },
        }),
        summary({
          capabilities: {
            kind: "declared",
            capabilities: {
              capabilities: [{ resource: "http", action: "get", target: "b.example.com" }],
              unknown: false,
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("is ordered over `calls`, because propagation picks the first witness", () => {
    expect(
      summariesEqual(summary({ calls: [RESOLVED, STUB] }), summary({ calls: [STUB, RESOLVED] })),
    ).toBe(false);
    expect(summariesEqual(summary({ calls: [RESOLVED] }), summary({ calls: [] }))).toBe(false);
  });

  it("separates each call kind's own propagation inputs", () => {
    expect(
      summariesEqual(
        summary({ calls: [RESOLVED] }),
        summary({ calls: [{ ...RESOLVED, callee: "a.ts#h" as SymbolId }] }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ calls: [RESOLVED] }),
        summary({ calls: [{ ...RESOLVED, location: ELSEWHERE }] }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ calls: [STUB] }),
        summary({ calls: [{ ...STUB, effects: ["network", "fs_read"] }] }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ calls: [STUB] }),
        summary({ calls: [{ ...STUB, capabilityTargetUnknown: true }] }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ calls: [STUB] }),
        summary({
          calls: [
            { ...STUB, requiredCapability: { resource: "http", action: "get", target: "x.com" } },
          ],
        }),
      ),
    ).toBe(false);
    // `escaping` is the whole mutation decision: `false` carries no effect,
    // `true` carries `state_write`.
    expect(
      summariesEqual(
        summary({ calls: [{ kind: "mutation", location: AT, escaping: false }] }),
        summary({ calls: [{ kind: "mutation", location: AT, escaping: true }] }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ calls: [{ kind: "mutation", location: AT, escaping: true }] }),
        summary({
          calls: [{ kind: "mutation", location: AT, escaping: true, unknownCallback: true }],
        }),
      ),
    ).toBe(false);
    // The reason is not cosmetic: it is what `--coverage`'s
    // `unresolved-by-reason` counts and what `ambit diff` compares.
    expect(
      summariesEqual(
        summary({ calls: [{ kind: "unresolved", location: AT, reason: "any-typed" }] }),
        summary({ calls: [{ kind: "unresolved", location: AT, reason: "callback-parameter" }] }),
      ),
    ).toBe(false);
    // Two kinds that both "contribute nothing" are still different summaries:
    // one says the callee is pure, the other says its calls are counted here.
    expect(
      summariesEqual(
        summary({ calls: [{ kind: "inlined", location: AT }] }),
        summary({ calls: [{ kind: "known-pure", location: AT, qualifiedName: "Array.map" }] }),
      ),
    ).toBe(false);
  });

  it("separates the body partitioning, which is what `ambit diff` compares per body", () => {
    expect(
      summariesEqual(summary({ calls: [STUB] }), summary({ calls: [STUB], bodies: [[STUB]] })),
    ).toBe(false);
    expect(
      summariesEqual(
        summary({ calls: [STUB], bodies: [[STUB], []] }),
        summary({ calls: [STUB], bodies: [[], [STUB]] }),
      ),
    ).toBe(false);
  });

  it("separates positions, which are part of the bytes §6.2 compares", () => {
    expect(summariesEqual(summary(), summary({ location: ELSEWHERE }))).toBe(false);
    expect(summariesEqual(summary(), summary({ declarationStart: ELSEWHERE }))).toBe(false);
    expect(summariesEqual(summary(), summary({ jsDocRange: AT }))).toBe(false);
    expect(summariesEqual(summary(), summary({ tagLocations: new Map([["effects", AT]]) }))).toBe(
      false,
    );
    expect(
      summariesEqual(
        summary({ tagLocations: new Map([["effects", AT]]) }),
        summary({ tagLocations: new Map([["effects", ELSEWHERE]]) }),
      ),
    ).toBe(false);
  });

  it("separates the declarability flags and the provenance a report prints", () => {
    expect(summariesEqual(summary(), summary({ undeclarable: true }))).toBe(false);
    expect(summariesEqual(summary(), summary({ configOnly: true }))).toBe(false);
    expect(summariesEqual(summary(), summary({ implicitConstructor: true }))).toBe(false);
    expect(summariesEqual(summary(), summary({ declaredBy: { effects: "config" } }))).toBe(false);
    expect(
      summariesEqual(
        summary({ declaredBy: { effects: "config" } }),
        summary({ declaredBy: { effects: "jsdoc" } }),
      ),
    ).toBe(false);
    expect(
      summariesEqual(
        summary(),
        summary({ divergences: [{ tag: "effects", jsDoc: "pure", config: "network" }] }),
      ),
    ).toBe(false);
  });
});

describe("changedSymbols", () => {
  const f = summary({ id: "a.ts#f" as SymbolId });
  const g = summary({ id: "a.ts#g" as SymbolId });

  it("is empty when nothing moved, whatever else the generation rebuilt", () => {
    const before = new Map([[f.id, f]]);
    // A different object with the same content — which is what every
    // generation produces, since extraction and summarization are redone from
    // a new snapshot every time.
    const after = new Map([[f.id, summary({ id: "a.ts#f" as SymbolId })]]);
    expect([...changedSymbols(before, after)]).toEqual([]);
  });

  it("holds an added id, a deleted id, and a changed one", () => {
    const before = new Map([
      [f.id, f],
      [g.id, g],
    ]);
    const after = new Map([
      [f.id, summary({ id: "a.ts#f" as SymbolId, calls: [STUB] })],
      ["a.ts#h" as SymbolId, summary({ id: "a.ts#h" as SymbolId })],
    ]);
    expect([...changedSymbols(before, after)].sort()).toEqual(["a.ts#f", "a.ts#g", "a.ts#h"]);
  });
});

describe("impactClosure", () => {
  const graph = (
    edges: Record<string, readonly string[]>,
  ): ReadonlyMap<SymbolId, ReadonlySet<SymbolId>> =>
    new Map(
      Object.entries(edges).map(([callee, callers]) => [
        callee as SymbolId,
        new Set(callers as readonly SymbolId[]),
      ]),
    );
  const empty = graph({});

  it("closes transitively over callers", () => {
    // c ← b ← a
    const calls = graph({ "a.ts#c": ["a.ts#b"], "a.ts#b": ["a.ts#a"] });
    expect([...impactClosure(new Set(["a.ts#c" as SymbolId]), empty, calls)].sort()).toEqual([
      "a.ts#a",
      "a.ts#b",
      "a.ts#c",
    ]);
  });

  it("terminates on a cycle and on self-recursion", () => {
    const cyclic = graph({ "a.ts#ping": ["a.ts#pong"], "a.ts#pong": ["a.ts#ping"] });
    expect([...impactClosure(new Set(["a.ts#ping" as SymbolId]), empty, cyclic)].sort()).toEqual([
      "a.ts#ping",
      "a.ts#pong",
    ]);
    const self = graph({ "a.ts#r": ["a.ts#r"] });
    expect([...impactClosure(new Set(["a.ts#r" as SymbolId]), empty, self)]).toEqual(["a.ts#r"]);
  });

  it("reaches a caller that exists only in the old graph", () => {
    // The edge `dropped → callee` was removed by this generation, so the new
    // graph cannot find `dropped` at all. This is the case the union exists
    // for. (With `S` decided by `summariesEqual`, such a caller is already in
    // `S` — its `calls` array lost an entry — so the union is a second,
    // independent reason rather than the only one. It is kept because that
    // second reason does not depend on the comparator being complete.)
    const before = graph({ "a.ts#callee": ["a.ts#dropped"] });
    const after = graph({});
    expect([...impactClosure(new Set(["a.ts#callee" as SymbolId]), before, after)].sort()).toEqual([
      "a.ts#callee",
      "a.ts#dropped",
    ]);
    // Without the old graph it would not be found — which is what the union
    // buys, stated as an assertion rather than as a comment.
    expect([...impactClosure(new Set(["a.ts#callee" as SymbolId]), empty, after)]).toEqual([
      "a.ts#callee",
    ]);
  });

  it("reaches a caller that exists only in the new graph", () => {
    const after = graph({ "a.ts#callee": ["a.ts#added"] });
    expect([...impactClosure(new Set(["a.ts#callee" as SymbolId]), empty, after)].sort()).toEqual([
      "a.ts#added",
      "a.ts#callee",
    ]);
  });

  it("is empty for an empty changed set", () => {
    const calls = graph({ "a.ts#c": ["a.ts#b"] });
    expect([...impactClosure(new Set(), calls, calls)]).toEqual([]);
  });
});
