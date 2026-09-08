import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
import { diagnose } from "../src/checker/diagnose.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { Diagnostic } from "../src/core/index.ts";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "propagation");

async function diagnoseFixtures(): Promise<readonly Diagnostic[]> {
  const files = await legacyTsBackend.extractProject(FIXTURE_ROOT);
  const summaries = summarizeExtractedFiles(files);
  const state = propagate(summaries);
  return diagnose(state);
}

/**
 * Find the diagnostic *about* `fnName` — not one that merely mentions it
 * (a callee's name legitimately appears inside its caller's message text
 * too). The subject function name is always the message's leading token.
 */
function byFunction(diagnostics: readonly Diagnostic[], fnName: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.message.startsWith(`${fnName} `));
}

describe("diagnose (end-to-end: backend -> summarize -> propagate -> diagnose)", () => {
  it("rule 2: flags a pure function that calls fetch directly (§5.1 shape)", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "pureCallsFetchDirectly");
    expect(diag).toBeDefined();
    expect(diag).toMatchObject({
      id: "AMB-E001",
      severity: "error",
      category: "effects",
      contract: { declared: [], observed: ["network"], via: [] },
      fixes: [],
    });
    expect(diag?.location.file.endsWith("rule2-direct.ts")).toBe(true);
    expect(diag?.location.line).toBeGreaterThan(0);
  });

  it("rule 5: await does not hide a direct fetch call from detection", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "pureAsyncCallsFetchDirectly");
    expect(diag?.id).toBe("AMB-E001");
  });

  it("rule 1: propagates through a declared callee, with via pointing at it", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "calculateTaxDeclaredCallee");
    expect(diag?.id).toBe("AMB-E001");
    expect(diag?.contract?.observed).toEqual(["network"]);
    expect(diag?.contract?.via.map((v) => v.symbol)).toEqual([
      "rule1-declared-callee.ts#fetchRateDeclared",
    ]);
  });

  it("rule 1: propagates through an undeclared callee's inferred effects", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "calculateTaxUndeclaredCallee");
    expect(diag?.id).toBe("AMB-E001");
    expect(diag?.contract?.via.map((v) => v.symbol)).toEqual([
      "rule1-undeclared-callee.ts#fetchRateUndeclared",
    ]);
  });

  it("does not diagnose an undeclared function itself", async () => {
    const diagnostics = await diagnoseFixtures();
    expect(byFunction(diagnostics, "fetchRateUndeclared")).toBeUndefined();
  });

  it("cycle: converges and reports the multi-hop via chain", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "pureEntryToCycle");
    expect(diag?.id).toBe("AMB-E001");
    expect(diag?.contract?.via.map((v) => v.symbol)).toEqual([
      "cycle.ts#cycleA",
      "cycle.ts#cycleB",
    ]);
  });

  it("rule 3: pure reaching an unresolved call warns with AMB-W001, not AMB-E001", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "pureReachesUnknown");
    expect(diag?.id).toBe("AMB-W001");
    expect(diag?.severity).toBe("warning");
    expect(diag?.contract?.via.map((v) => v.symbol)).toEqual([
      "rule3-unknown.ts#callsSomethingUnresolved",
    ]);
  });

  it("rule 6: a direct dynamic import() also warns via AMB-W001", async () => {
    const diagnostics = await diagnoseFixtures();
    const diag = byFunction(diagnostics, "pureReachesDynamicImport");
    expect(diag?.id).toBe("AMB-W001");
  });

  it("every diagnostic's location is 1-based", async () => {
    const diagnostics = await diagnoseFixtures();
    for (const diag of diagnostics) {
      expect(diag.location.line).toBeGreaterThan(0);
      expect(diag.location.col).toBeGreaterThan(0);
    }
  });
});
