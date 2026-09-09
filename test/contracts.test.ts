import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
import { computeCoverage } from "../src/checker/coverage.ts";
import { diagnose, diagnoseRuntimeWrappers } from "../src/checker/diagnose.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { Diagnostic } from "../src/core/index.ts";
import {
  formatBudget,
  isCapabilitiesContract,
  parseBudgetTag,
  parseCapabilitiesTag,
  parseCapability,
} from "../src/core/index.ts";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "contracts");
const WRAPPER_ROOT = path.join(import.meta.dirname, "fixtures", "wrappers");
const ENGINE = { name: "test", version: "0" };

async function analyze(root: string) {
  const project = await legacyTsBackend.extractProject(root);
  const summaries = summarizeExtractedFiles(project.files);
  const state = propagate(summaries);
  return {
    project,
    summaries,
    state,
    diagnostics: [
      ...diagnose(state, ENGINE),
      // The same two passes the CLI runs (`src/cli/main.ts`); a helper that
      // omitted the wrapper pass would report "no mismatch" for a fixture the
      // CLI fails.
      ...diagnoseRuntimeWrappers(
        project.files.flatMap((file) => file.runtimeWrappers),
        state,
        ENGINE,
      ),
    ],
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

describe("capability parsing (DESIGN.md §4.4)", () => {
  it("parses <resource>:<action>:<target>", () => {
    expect(parseCapability("db:read:users")).toEqual({
      resource: "db",
      action: "read",
      target: "users",
    });
  });

  it("keeps a colon inside the target", () => {
    expect(parseCapability("http:get:localhost:8080")?.target).toBe("localhost:8080");
  });

  it("rejects a token that is not three non-empty segments", () => {
    expect(parseCapability("db:read")).toBeUndefined();
    expect(parseCapability("db::users")).toBeUndefined();
    expect(parseCapability(":read:users")).toBeUndefined();
    expect(parseCapability("db:read:")).toBeUndefined();
  });

  it("rejects a glob outside the target segment", () => {
    // A `*` in resource or action reads as a restriction while meaning the
    // opposite; §4.4 makes only the target globbable.
    expect(parseCapability("*:read:users")).toBeUndefined();
    expect(parseCapability("db:*:users")).toBeUndefined();
    expect(parseCapability("db:read:*")).toBeDefined();
  });

  it("rejects the whole list when one token is malformed", () => {
    expect(parseCapabilitiesTag("db:read:users, broken")).toBeUndefined();
  });
});

describe("budget parsing (DESIGN.md §4.5)", () => {
  it("parses limits and defaults onExceed to throw", () => {
    expect(parseBudgetTag("timeMs=500 costUsd=0.01 llmCalls=2")).toEqual({
      timeMs: 500,
      costUsd: 0.01,
      llmCalls: 2,
      onExceed: "throw",
    });
  });

  it("round-trips through formatBudget", () => {
    const budget = parseBudgetTag("timeMs=500 onExceed=abort");
    expect(budget && formatBudget(budget)).toBe("timeMs=500 onExceed=abort");
  });

  it("rejects malformed budgets rather than applying them in part", () => {
    for (const text of [
      "timeMs=notANumber",
      "timeMs=-1",
      "llmCalls=1.5",
      "onExceed=explode timeMs=1",
      "unknownKey=1",
      "timeMs=1 timeMs=2",
      "onExceed=warn",
      "",
    ]) {
      expect(parseBudgetTag(text), text).toBeUndefined();
    }
  });
});

describe("@capabilities narrowing (DESIGN.md §4.4)", () => {
  it("reports a callee requiring a capability the caller does not grant", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    const [diagnostic] = forFunction(diagnostics, "readsThenWrites");
    expect(diagnostic?.id).toBe("AMB-E005");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.category).toBe("capabilities");
    const contract = diagnostic?.contract;
    expect(contract && isCapabilitiesContract(contract)).toBe(true);
    if (contract && isCapabilitiesContract(contract)) {
      expect(contract.declared).toEqual(["db:read:users"]);
      expect(contract.excess).toEqual(["db:write:users"]);
      expect(contract.via.map((v) => v.symbol)).toEqual(["sample.ts#writeUser"]);
    }
  });

  it("accepts a target glob that covers the callee's concrete target", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "readsUnderGlob")).toEqual([]);
  });

  it("checks through an undeclared middle function", async () => {
    // A(grants X) → B(undeclared) → C(declares Y): Y must still be checked
    // against X, or an undeclared hop would launder any escalation.
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    const [diagnostic] = forFunction(diagnostics, "callsThroughMiddle");
    expect(diagnostic?.id).toBe("AMB-E005");
    expect(diagnostic?.message).toContain("db:write:users");
  });

  it("rejects a malformed @capabilities tag instead of honouring part of it", async () => {
    const { diagnostics, summaries } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "malformedCapability")[0]?.id).toBe("AMB-E004");
    expect(forFunction(diagnostics, "globInResourceSegment")[0]?.id).toBe("AMB-E004");
    // …and the function is treated as undeclared, not as granting something.
    const summary = summaries.find((s) => s.id === "sample.ts#malformedCapability");
    expect(summary?.capabilities.kind).toBe("invalid");
  });
});

describe("@entrypoint (DESIGN.md §4.4)", () => {
  it("warns when an entrypoint declares no capabilities", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    const [diagnostic] = forFunction(diagnostics, "entrypointWithoutCapabilities");
    expect(diagnostic?.id).toBe("AMB-W002");
    expect(diagnostic?.severity).toBe("warning");
  });

  it("stays quiet when the entrypoint declares both", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "declaredEntrypoint")).toEqual([]);
  });

  it("counts entrypoints and uncovered entrypoints in coverage", async () => {
    const { coverage } = await analyze(FIXTURE_ROOT);
    expect(coverage.functionsEntrypoint).toBe(2);
    expect(coverage.entrypointsWithoutCapabilities).toBe(1);
  });
});

describe("@boundary (DESIGN.md §4.6)", () => {
  it("takes the declared contract instead of analyzing the body", async () => {
    const { state, diagnostics } = await analyze(FIXTURE_ROOT);
    // The body performs `fetch`, and `understatedBoundary` declares `pure`.
    // §4.6 says the body is not checked — that is what the tag buys and what
    // it costs. It must not produce AMB-E001.
    expect(forFunction(diagnostics, "understatedBoundary")).toEqual([]);
    const understated = state.get("sample.ts#understatedBoundary" as never);
    expect(understated?.observed.effects.size).toBe(0);
  });

  it("propagates the declared contract, not the body, to callers", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "callsBoundary")).toEqual([]);
  });

  it("rejects a @boundary with no reason", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "boundaryWithoutReason")[0]?.id).toBe("AMB-E006");
  });

  it("rejects a @boundary with nothing declared in the body's place", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "boundaryWithoutEffects")[0]?.id).toBe("AMB-E007");
  });

  it("names the boundary, not a phantom unresolved call, when capabilities go unknown", async () => {
    // Every call in the caller resolves; the requirement is unknown because
    // the boundary declared nothing about capabilities. Saying "reaches a
    // call that could not be resolved" would send a reader hunting.
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    const [diagnostic] = forFunction(diagnostics, "callsCapabilitylessBoundary");
    expect(diagnostic?.id).toBe("AMB-W003");
    expect(diagnostic?.message).toContain(
      "calls boundaryWithoutCapabilities, a @boundary that declares no @capabilities",
    );
  });

  it("does not add AMB-E007 on top of an @effects that failed to parse", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "boundaryWithInvalidEffects").map((d) => d.id)).toEqual([
      "AMB-E002",
    ]);
  });

  it("keeps a boundary's own call sites out of the resolution statistics", async () => {
    // A boundary's body is not propagated, so its calls say nothing about how
    // well analysis resolves — counting them would show a declared hole as
    // unresolved analysis and pad the "what to stub next" signal.
    const { coverage } = await analyze(FIXTURE_ROOT);
    expect(coverage.callSitesUnresolved).toBe(0);
    expect(coverage.topUnresolvedNames).toEqual([]);
  });

  it("reports the boundary rate beside the unknown rate", async () => {
    // §4.3: tagging a function @boundary takes it out of the unknown
    // numerator without its body ever being checked. Reported together so
    // that move cannot read as an improving KPI.
    const { coverage } = await analyze(FIXTURE_ROOT);
    expect(coverage.functionBoundaryRate).toBeCloseTo(
      coverage.functionsBoundary / coverage.functionsExtracted,
    );
    expect(coverage.functionsBoundary).toBeGreaterThan(0);
  });

  it("counts boundaries apart from analysis successes", async () => {
    // §4.3: 「境界への移行は解析成功と区別して集計する」.
    const { coverage } = await analyze(FIXTURE_ROOT);
    expect(coverage.functionsBoundary).toBe(5);
  });
});

describe("@budget (DESIGN.md §4.5)", () => {
  it("rejects a malformed budget", async () => {
    const { diagnostics } = await analyze(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "malformedBudget")[0]?.id).toBe("AMB-E008");
    expect(forFunction(diagnostics, "malformedOnExceed")[0]?.id).toBe("AMB-E008");
  });

  it("carries a well-formed budget on the summary", async () => {
    const { summaries } = await analyze(FIXTURE_ROOT);
    const entrypoint = summaries.find((s) => s.id === "sample.ts#declaredEntrypoint");
    expect(entrypoint?.budget).toEqual({
      kind: "declared",
      budget: { timeMs: 500, costUsd: 0.01, llmCalls: 2, onExceed: "warn" },
    });
  });
});

describe("contract-to-handler agreement (DESIGN.md §4.4「契約とハンドラの対応付け（決定）」)", () => {
  /**
   * §4.4 chose explicit registration, which leaves the capability set written
   * twice — in the JSDoc and in the `spec`. The duplication does not go away,
   * so the source-level agreement check has to reach the adapter's
   * registrations as well as a hand-written `withAmbit`, or choosing that
   *方式 would have quietly dropped a check.
   */
  it("catches a hand-written withAmbit that drifts from the handler's @capabilities", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    const found = diagnostics.filter((d) => d.id === "AMB-E010" && d.message.includes("drifting "));
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("withAmbit grants [db:write:orders]");
  });

  it("catches an ambitHandler registration that drifts the same way", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    const found = diagnostics.filter(
      (d) => d.id === "AMB-E010" && d.message.includes("driftingByAdapter"),
    );
    expect(found).toHaveLength(1);
    // The diagnostic names the call the source wrote, not the other form.
    expect(found[0]?.message).toContain("ambitHandler grants [db:write:orders]");
  });

  it("stays quiet when the adapter's registration agrees with the JSDoc", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    expect(diagnostics.filter((d) => d.message.includes("agreeing"))).toEqual([]);
  });

  it("reports an adapter registration it cannot compare as AMB-W004 rather than passing it", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    // Filtered by reason, not counted: the two halves are reported
    // independently, so the fixture now holds one uncompared capability list
    // and one uncompared budget.
    const found = diagnostics.filter(
      (d) => d.id === "AMB-W004" && d.message.includes("not a literal array of strings"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("ambitHandler here was not compared");
    expect(found[0]?.severity).toBe("warning");
  });

  /**
   * §4.4's duplication is not only the capability set: `spec.budget` and
   * `@budget` are the same contract written twice, and an agent that widens
   * one of them moves the limit the runtime actually applies away from the
   * one the source declares. Its own id, AMB-E011 — AMB-E010's `contract`
   * field is capability text, which a budget disagreement cannot fill.
   */
  it("catches a spec budget whose timeMs drifts from the handler's @budget", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    const found = diagnostics.filter(
      (d) => d.id === "AMB-E011" && d.message.includes("driftingTimeMs"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("error");
    expect(found[0]?.category).toBe("budget");
    expect(found[0]?.message).toContain("ambitHandler sets budget timeMs=5000");
    expect(found[0]?.message).toContain("declares @budget timeMs=800");
  });

  it("catches a spec budget whose onExceed drifts from the handler's @budget", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    const found = diagnostics.filter(
      (d) => d.id === "AMB-E011" && d.message.includes("driftingOnExceed"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("withAmbit sets budget timeMs=500 onExceed=abort");
    expect(found[0]?.message).toContain("declares @budget timeMs=500 onExceed=warn");
  });

  it("treats a limit declared on one side only as a disagreement", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    const found = diagnostics.filter(
      (d) => d.id === "AMB-E011" && d.message.includes("jsDocOnlyCostUsd"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("declares @budget timeMs=500 costUsd=0.01");
    expect(found[0]?.message).not.toContain("sets budget timeMs=500 costUsd");
  });

  it("stays quiet when the spec omits onExceed and the @budget takes its default", async () => {
    // `parseBudgetTag` writes `onExceed=throw` into a tag that omits it, and
    // the runtime defaults the spec's the same way — comparing the two
    // un-defaulted would report a disagreement neither side has.
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    expect(diagnostics.filter((d) => d.message.includes("agreeingBudget"))).toEqual([]);
  });

  it("reports a budget it cannot compare as AMB-W004 rather than passing it", async () => {
    const { diagnostics } = await analyze(WRAPPER_ROOT);
    const found = diagnostics.filter(
      (d) => d.id === "AMB-W004" && d.message.includes("its budget is not an object literal"),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.severity).toBe("warning");
    expect(found[0]?.message).toContain("source only");
    // The capability half of the same registration is a literal, so it is
    // still compared: not knowing one half does not silence the other.
    expect(
      diagnostics.filter((d) => d.id === "AMB-E010" && d.message.includes("dynamicBudget")),
    ).toEqual([]);
  });
});
