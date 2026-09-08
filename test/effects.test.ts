import { describe, expect, it } from "vitest";
import {
  effectSetOf,
  effectSetsEqual,
  emptyEffectSet,
  excessEffects,
  unionEffectSets,
  unknownEffectSet,
  withImpliedEffects,
} from "../src/core/effects.ts";

describe("EffectSet", () => {
  it("pure is the empty effect set (DESIGN.md §4.2 rule 2)", () => {
    const pure = emptyEffectSet();
    expect(pure.effects.size).toBe(0);
    expect(pure.unknown).toBe(false);
  });

  it("llm implies network", () => {
    const set = effectSetOf("llm");
    expect(set.effects.has("network")).toBe(true);
    expect(set.effects.has("llm")).toBe(true);
  });

  it("withImpliedEffects is idempotent when network is already present", () => {
    const set = effectSetOf("llm", "network");
    expect(withImpliedEffects(set).effects.size).toBe(2);
  });

  it("unionEffectSets merges effects and unknown flags, and re-applies implied effects", () => {
    const a = effectSetOf("db_read");
    const b = { effects: new Set<"llm">(["llm"]), unknown: true };
    const union = unionEffectSets(a, b);
    expect(union.unknown).toBe(true);
    expect([...union.effects].sort()).toEqual(["db_read", "llm", "network"]);
  });

  it("excessEffects reports only what the declared set does not cover", () => {
    const declared = effectSetOf("db_read");
    const observed = effectSetOf("db_read", "network");
    expect([...excessEffects(declared, observed)]).toEqual(["network"]);
  });

  it("excessEffects is empty when declared covers observed", () => {
    const declared = effectSetOf("network", "db_read");
    const observed = effectSetOf("network");
    expect(excessEffects(declared, observed).size).toBe(0);
  });

  it("effectSetsEqual distinguishes unknown from an equal-looking known set", () => {
    expect(effectSetsEqual(emptyEffectSet(), unknownEffectSet())).toBe(false);
    expect(effectSetsEqual(effectSetOf("network"), effectSetOf("network"))).toBe(true);
  });
});
