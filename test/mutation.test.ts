import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeCoverage } from "../src/checker/coverage.ts";
import { diagnose } from "../src/checker/diagnose.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { Diagnostic } from "../src/core/index.ts";
import { extractFixture } from "./support/extract.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "mutation");
const ENGINE = { name: "test", version: "0" };

async function analyze() {
  const project = await extractFixture(FIXTURE);
  const summaries = summarizeExtractedFiles(project.files);
  const state = propagate(summaries);
  return {
    summaries,
    state,
    diagnostics: diagnose(state, ENGINE),
    coverage: computeCoverage({
      filesAnalyzed: project.files.length,
      skippedFunctions: project.skippedFunctions,
      summaries,
      state,
    }),
  };
}

function forFunction(diagnostics: readonly Diagnostic[], name: string): readonly Diagnostic[] {
  return diagnostics.filter((d) => d.message.startsWith(`${name} `));
}

function observedOf(
  state: Awaited<ReturnType<typeof analyze>>["state"],
  name: string,
): readonly string[] {
  for (const [id, propagated] of state) {
    if (id.endsWith(`#${name}`)) return [...propagated.observed.effects].sort();
  }
  throw new Error(`no function named ${name} in the fixture`);
}

describe("local mutation and `pure` (DESIGN.md §4.2)", () => {
  it("allows mutating a value the function itself allocated", async () => {
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "localArrayPush")).toEqual([]);
    expect(observedOf(state, "localArrayPush")).toEqual([]);
  });

  it("allows local collections mutated inside an inline callback", async () => {
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "localCollectionsInCallback")).toEqual([]);
    expect(observedOf(state, "localCollectionsInCallback")).toEqual([]);
  });

  it("reports mutating a parameter as a `pure` violation", async () => {
    const { diagnostics, state } = await analyze();
    const [diagnostic] = forFunction(diagnostics, "mutatesParameter");
    expect(diagnostic?.id).toBe("AMB-E001");
    expect(diagnostic?.message).toBe(
      "mutatesParameter declares pure but performs [state_write] directly",
    );
    expect(observedOf(state, "mutatesParameter")).toEqual(["state_write"]);
  });

  it("reports assigning through a parameter as a `pure` violation", async () => {
    const { diagnostics } = await analyze();
    expect(forFunction(diagnostics, "assignsToParameter")[0]?.id).toBe("AMB-E001");
  });

  it("reports mutating a module-scope binding as a `pure` violation", async () => {
    const { diagnostics } = await analyze();
    expect(forFunction(diagnostics, "mutatesModuleScope")[0]?.id).toBe("AMB-E001");
  });

  it("reports mutation through `this` as a `pure` violation", async () => {
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "record")[0]?.id).toBe("AMB-E001");
    expect(observedOf(state, "Counter.record")).toEqual(["state_write"]);
  });

  it("over-approximates a `let`-bound local to `state_write`", async () => {
    // §4.2「ローカル判定の規則」: only a `const` bound to a fresh allocation is
    // local. A `let` can be reassigned to something the caller holds, and the
    // undecidable side is deliberately the effect, not silence.
    const { diagnostics } = await analyze();
    expect(forFunction(diagnostics, "reassignsLooseLocal")[0]?.id).toBe("AMB-E001");
  });

  it("accepts a declared `state_write` for the same mutation", async () => {
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "declaresStateWrite")).toEqual([]);
    expect(observedOf(state, "declaresStateWrite")).toEqual(["state_write"]);
  });

  it("keeps a mutator with a by-reference callback unknown, not silently pure", async () => {
    // §4.2 rule 4: the callback's body is never walked, so its effects are not
    // known — a local mutation cannot make that go away.
    const { diagnostics, state } = await analyze();
    const [diagnostic] = forFunction(diagnostics, "sortsLocalWithOpaqueComparator");
    expect(diagnostic?.id).toBe("AMB-W001");
    expect(observedOf(state, "sortsLocalWithOpaqueComparator")).toEqual([]);
    for (const [id, propagated] of state) {
      if (!id.endsWith("#sortsLocalWithOpaqueComparator")) continue;
      expect(propagated.observed.unknown).toBe(true);
    }
  });

  it("allows a base-class constructor to write its own fields", async () => {
    // With `erasableSyntaxOnly` there are no parameter properties, so
    // `this.x = x` is the only way to write a field. §4.2 treats the `this` of
    // an `extends`-less constructor as the object it just allocated.
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "Point.constructor")).toEqual([]);
    expect(observedOf(state, "Point.constructor")).toEqual([]);
  });

  it("reports a derived constructor's field write, because `super` ran first", async () => {
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "Shifted.constructor")[0]?.message).toBe(
      "Shifted.constructor declares pure but performs [state_write] directly",
    );
    expect(observedOf(state, "Shifted.constructor")).toEqual(["state_write"]);
  });

  it("allows a destructuring assignment whose every leaf is a local", async () => {
    const { diagnostics } = await analyze();
    expect(forFunction(diagnostics, "destructuresIntoLocals")).toEqual([]);
  });

  it("reports a destructuring assignment that writes through a parameter", async () => {
    const { diagnostics, state } = await analyze();
    expect(forFunction(diagnostics, "destructuresIntoParameter")[0]?.id).toBe("AMB-E001");
    expect(observedOf(state, "destructuresIntoParameter")).toEqual(["state_write"]);
  });

  it("counts mutation sites apart from pure and unresolved ones", async () => {
    const { coverage } = await analyze();
    expect(coverage.callSitesMutation).toBeGreaterThan(0);
  });
});
