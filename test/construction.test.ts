import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/backend/legacy-ts.ts";
import { diagnose } from "../src/checker/diagnose.ts";
import { propagate } from "../src/checker/propagate.ts";
import { summarizeExtractedFiles } from "../src/checker/summarize.ts";
import type { Diagnostic } from "../src/core/index.ts";

const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "construction");
const ENGINE = { name: "test", version: "0" };

async function check(root: string): Promise<{
  diagnostics: readonly Diagnostic[];
  state: Awaited<ReturnType<typeof analyze>>["state"];
}> {
  const { state } = await analyze(root);
  return { diagnostics: diagnose(state, ENGINE), state };
}

async function analyze(root: string) {
  const project = await legacyTsBackend.extractProject(root);
  const summaries = summarizeExtractedFiles(project.files);
  return { project, summaries, state: propagate(summaries) };
}

function forFunction(diagnostics: readonly Diagnostic[], name: string): readonly Diagnostic[] {
  return diagnostics.filter((d) => d.location.line > 0 && d.message.startsWith(`${name} `));
}

describe("construction (new X / super) is part of the call graph", () => {
  // DESIGN.md §3.4: an unanalyzed path must stay visible. Before this,
  // `new X(...)` produced no call site at all, so a `pure` function that
  // constructed a networking client passed the check silently.
  it("propagates a constructor's own effects to the constructing function", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    const [diagnostic] = forFunction(diagnostics, "constructsDirectly");
    expect(diagnostic?.id).toBe("AMB-E001");
    expect(diagnostic?.contract?.observed).toContain("network");
    expect(diagnostic?.message).toContain("HttpClient.constructor");
  });

  it("propagates through a derived class's implicit base constructor", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsDerived")[0]?.id).toBe("AMB-E001");
  });

  it("propagates a class's property initializers, with no constructor written", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsFieldInitializer")[0]?.id).toBe("AMB-E001");
  });

  it("propagates through an explicit super(...) call", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsExplicitSuper")[0]?.id).toBe("AMB-E001");
  });

  it("reports nothing when the construction's effects are declared", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "declaresNetworkForConstruction")).toEqual([]);
  });

  it("lets a constructor carry its own @effects contract", async () => {
    const { summaries } = await analyze(FIXTURE_ROOT);
    const declared = summaries.find((s) => s.id === "sample.ts#Declared.constructor");
    expect(declared?.declared).toEqual({
      kind: "declared",
      effects: { effects: new Set(["network"]), unknown: false },
    });
  });

  it("does not read a class's own JSDoc as its implicit constructor's contract", async () => {
    // `/** @effects pure */ class C {}` documents the class. Treating it as a
    // verified constructor contract would manufacture a guarantee.
    const { summaries } = await analyze(FIXTURE_ROOT);
    const implicit = summaries.find((s) => s.id === "sample.ts#EagerFields.constructor");
    expect(implicit?.declared.kind).toBe("none");
  });
});

describe("a class property holding a function is a method, not construction work", () => {
  it("does not attribute an arrow property's body to the constructor", async () => {
    // Constructing the class creates the closure; it does not run it.
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsController")).toEqual([]);
  });

  it("indexes the arrow property in its own right, so calling it propagates", async () => {
    const { diagnostics, state } = await check(FIXTURE_ROOT);
    expect([...state.keys()]).toContain("sample.ts#Controller.handle");
    const [diagnostic] = forFunction(diagnostics, "callsArrowMethod");
    expect(diagnostic?.id).toBe("AMB-E001");
    expect(diagnostic?.contract?.observed).toContain("network");
  });

  it("still treats a non-function property initializer as construction work", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsFieldInitializer")[0]?.id).toBe("AMB-E001");
  });
});

describe("constructor stub table", () => {
  it("treats an allowlisted builtin construction as effect-free", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsPureBuiltin")).toEqual([]);
  });

  it("treats new Date() as env but new Date(y, m, d) as effect-free", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "readsClock")[0]?.contract?.observed).toEqual(["env"]);
    expect(forFunction(diagnostics, "fixedDate")).toEqual([]);
  });

  it("leaves a construction it cannot name as unknown, not as effect-free", async () => {
    const { diagnostics } = await check(FIXTURE_ROOT);
    expect(forFunction(diagnostics, "constructsAnonymousClass")[0]?.id).toBe("AMB-W001");
  });
});

describe("construction on Ambit's own source (self-hosting)", () => {
  const SRC_ROOT = path.join(import.meta.dirname, "..", "src");

  it("records a construction as a call site rather than dropping it", async () => {
    const { project } = await analyze(SRC_ROOT);
    const propagateFn = project.files
      .find((f) => f.filePath === "checker/propagate.ts")
      ?.functions.find((fn) => fn.id === "checker/propagate.ts#propagate");
    // `propagate` builds `new Map(...)` twice; before constructions were
    // recorded, neither appeared in `calls` at all.
    expect(propagateFn?.calls).toContainEqual(
      expect.objectContaining({ calleeQualifiedName: "new Map" }),
    );
  });
});
