/**
 * The shadow comparison's own correctness.
 *
 * The comparison (`scripts/shadow/normalize.ts`, `scripts/shadow/compare.ts`)
 * decides whether a second backend agrees with the adopted one, so a bug in it
 * reads as a compiler divergence that is not there — or, worse, hides one that
 * is. Both halves are pure over the analysis output, so both are tested here
 * without the native engine installed; `scripts/shadow/native-ts7-backend.ts`
 * needs a compiler that is not a dependency and is exercised by
 * `node scripts/shadow-analysis.ts` instead (see
 * `docs/measurements/2026-09-12-ts7-shadow-analysis.md`).
 *
 * The identity case is the load-bearing one: the adopted backend compared with
 * itself must produce **zero** divergences over real fixtures. Anything else is
 * a normalizer that is reading something unstable — an ordering, a compiler
 * offset — and every parity number it produces afterwards is noise.
 *
 * The rest are regression tests, one per divergence shape a real run found.
 * Each asserts that the comparison *reports* the shape and gives it the right
 * direction and risk, which is what the shadow report is read for.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareFacts } from "../scripts/shadow/compare.ts";
import { buildFacts, type ShadowFacts } from "../scripts/shadow/normalize.ts";
import {
  legacyTsBackend,
  loadConfig,
  resolveConfig,
  summarizeExtractedFiles,
} from "../src/checker/index.ts";
import { analyze } from "../src/cli/analyze.ts";
import type { AuthorityRecord, SymbolId } from "../src/core/index.ts";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");

async function factsFor(dir: string): Promise<ShadowFacts> {
  const project = await legacyTsBackend.extractProject(dir);
  const loaded = await loadConfig(dir);
  const config = loaded ? resolveConfig(loaded, dir) : undefined;
  const summaries = summarizeExtractedFiles(project.files, config);
  const analysis = await analyze(dir, { backend: legacyTsBackend });
  return buildFacts({
    backend: { name: legacyTsBackend.name, version: legacyTsBackend.version },
    durationMs: 1,
    project,
    summaries,
    analysis,
  });
}

describe("the shadow comparison is stable: one backend compared with itself", () => {
  // Three roots rather than all of them: these are the ones whose shapes the
  // normalizer has to key correctly — several calls on one line, an
  // inline-callback owner with several bodies, and cross-file resolution.
  for (const fixture of ["backend-conformance", "backend-smoke", "propagation"]) {
    it(`reports no divergence on ${fixture}`, async () => {
      const facts = await factsFor(path.join(FIXTURES, fixture));
      const report = compareFacts({
        root: fixture,
        authority: facts,
        shadow: facts,
        notPorted: [],
      });
      expect(report.divergences).toEqual([]);
      expect(report.highRiskCount).toBe(0);
      expect(report.decision.agree).toBe(true);
      // A parity of 1.00 over nothing compared is the failure this guards
      // against, so the counts behind the rate are asserted too.
      expect(report.parity.functions.agreed).toBeGreaterThan(0);
      expect(report.parity.calleeResolution.agreed).toBeGreaterThan(0);
    }, 30_000);
  }
});

// ---- hand-built pairs, one per divergence shape a real run found ----------

const EMPTY: ShadowFacts = {
  backend: { name: "x", version: "0" },
  durationMs: 1,
  functions: [],
  calls: [],
  summaryCalls: [],
  callEdges: [],
  skippedFunctions: [],
  uncarriedContracts: [],
  runtimeWrappers: [],
  diagnostics: [],
  authority: [],
  coverage: {
    functionsExtracted: 0,
    functionUnknownRate: 0,
    callSitesTotal: 0,
    callSitesUnresolved: 0,
    unresolvedByReason: [],
  },
  wouldPass: true,
};

function record(symbol: string, effects: readonly string[], unknown: boolean): AuthorityRecord {
  return {
    kind: "authority",
    symbol: symbol as SymbolId,
    location: { file: "a.ts", line: 1, col: 1, endLine: 1, endCol: 1 },
    entrypoint: false,
    effects: {
      declared: null,
      observed: effects as readonly AuthorityRecord["effects"]["observed"][number][],
      unknown,
    },
    capabilities: { declared: null, required: [], unknown },
    unresolved: [],
    paths: [],
  };
}

function compare(authority: Partial<ShadowFacts>, shadow: Partial<ShadowFacts>) {
  return compareFacts({
    root: "t",
    authority: { ...EMPTY, ...authority },
    shadow: { ...EMPTY, ...shadow },
    notPorted: [],
  });
}

describe("a shadow backend that reports less is high-risk", () => {
  it("flags a lost effect as shadow-less-authority", () => {
    // `runtime/enforce.ts#setUnscopedPolicy` on `src`: a module-scope
    // identifier rebinding is a `state_write`, and a port that only looked at
    // property writes dropped it.
    const report = compare(
      { authority: [record("a.ts#f", ["state_write"], false)] },
      { authority: [record("a.ts#f", [], false)] },
    );
    const found = report.divergences.find((d) => d.category === "authority");
    expect(found?.direction).toBe("shadow-less-authority");
    expect(found?.risk).toBe("high");
    // Twice, and that is the point: the same loss is visible as a propagated
    // effect and as authority, and direction is now read off both dimensions'
    // own values rather than only off `diffAuthority`. A rendered-string
    // comparison called the propagated-effect half a plain `value-mismatch`
    // at normal risk, which is the shape a real regression would have hidden
    // in.
    const propagated = report.divergences.find((d) => d.category === "propagated-effect");
    expect(propagated?.direction).toBe("shadow-less-authority");
    expect(propagated?.risk).toBe("high");
    expect(report.highRiskCount).toBe(2);
    expect(report.authorityDiff.decreases).toBe(1);
  });

  it("flags a lost `unknown` as shadow-less-unknown", () => {
    // `generics.ts#genericHigherOrder` on the conformance fixtures: a callback
    // passed by reference must leave the call `unknown` (DESIGN.md §4.2 rule
    // 4). A port that decided callability from the callee's declaration
    // instead of the argument's type reported the call as fully analyzed.
    const report = compare(
      { authority: [record("a.ts#f", [], true)] },
      { authority: [record("a.ts#f", [], false)] },
    );
    const found = report.divergences.find((d) => d.category === "authority");
    expect(found?.direction).toBe("shadow-less-unknown");
    expect(found?.risk).toBe("high");
    expect(report.authorityDiff.unknownLost).toBe(1);
  });

  it("does not call extra `unknown` high-risk", () => {
    const report = compare(
      { authority: [record("a.ts#f", [], false)] },
      { authority: [record("a.ts#f", [], true)] },
    );
    const found = report.divergences.find((d) => d.category === "authority");
    expect(found?.direction).toBe("shadow-more-unknown");
    expect(found?.risk).toBe("normal");
    expect(report.highRiskCount).toBe(0);
  });

  it("flags a disagreeing pass/fail decision, in the direction that passes", () => {
    const report = compare({ wouldPass: false }, { wouldPass: true });
    const found = report.divergences.find((d) => d.category === "ci-decision");
    expect(found?.risk).toBe("high");
    expect(report.decision.agree).toBe(false);
  });
});

describe("divergence shapes are reported with their own category", () => {
  it("reports a differing jsDocRange as a function divergence", () => {
    // Measured on the conformance fixtures: a JSDoc node's own text is trivia,
    // so `getStart()` skips past the comment and `getFullStart()` sits where
    // the preceding trivia began — every block's range started in the wrong
    // place until the trivia was walked.
    const fn = {
      symbol: "a.ts#f" as SymbolId,
      location: "a.ts:2:1-2:2",
      declarationStart: "a.ts:2:1-2:1",
      jsDocTags: [],
      flags: [],
      bodyCount: 1,
    };
    const report = compare(
      { functions: [{ ...fn, jsDocRange: "a.ts:1:1-1:20" }] },
      { functions: [{ ...fn, jsDocRange: "a.ts:1:1-1:99" }] },
    );
    expect(report.divergences.map((d) => d.category)).toEqual(["function"]);
    expect(report.parity.functions.disagreed).toBe(1);
  });

  it("reports a call the shadow backend could not resolve, and classifies the known gap", () => {
    const call = { owner: "a.ts#f" as SymbolId, location: "a.ts:3:3-3:9", ordinal: 0 };
    const report = compare(
      { calls: [{ ...call, resolvedCallee: "a.ts#g" as SymbolId }] },
      { calls: [{ ...call, unresolvedReason: "unresolved-symbol" }] },
    );
    const found = report.divergences.find((d) => d.category === "callee-resolution");
    expect(found?.authorityValue).toBe("resolved=a.ts#g");
    expect(found?.shadowValue).toBe("unresolvedReason=unresolved-symbol");
    // A shape the port has not taken on must not read as a compiler
    // disagreement, or the remaining divergences stop being worth reading.
    expect(found?.classification).toBe("not-yet-ported");
    expect(found?.note).toBeTruthy();
  });

  it("reports a missing call-graph edge", () => {
    const report = compare({ callEdges: ["a.ts#f calls a.ts#g"] }, { callEdges: [] });
    const found = report.divergences.find((d) => d.category === "call-edge");
    expect(found?.direction).toBe("shadow-missing");
    expect(report.parity.callEdges.authorityOnly).toBe(1);
  });

  it("reports a backend error rather than an empty parity", () => {
    const report = compareFacts({
      root: "t",
      authority: EMPTY,
      shadow: EMPTY,
      notPorted: [],
      errors: [{ backend: "shadow", phase: "analyze", message: "boom" }],
    });
    const found = report.divergences.find((d) => d.category === "backend-error");
    expect(found?.risk).toBe("high");
    expect(report.errors).toHaveLength(1);
  });
});

describe("the comparison is deterministic", () => {
  it("sorts divergences high-risk first, then by category and symbol", () => {
    const report = compare(
      {
        callEdges: ["z.ts#z calls z.ts#y"],
        authority: [record("a.ts#f", ["network"], false), record("b.ts#g", [], false)],
      },
      { callEdges: [], authority: [record("a.ts#f", [], false), record("b.ts#g", [], false)] },
    );
    const risks = report.divergences.map((d) => d.risk);
    expect(risks).toEqual(
      [...risks].toSorted((a, b) => Number(b === "high") - Number(a === "high")),
    );
    // Same input, same output — the property every parity number rests on.
    const again = compare(
      {
        callEdges: ["z.ts#z calls z.ts#y"],
        authority: [record("a.ts#f", ["network"], false), record("b.ts#g", [], false)],
      },
      { callEdges: [], authority: [record("a.ts#f", [], false), record("b.ts#g", [], false)] },
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });
});
