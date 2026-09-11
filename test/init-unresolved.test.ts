import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/core/index.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "init-unresolved");

async function run(
  command: string,
  dir: string,
): Promise<{ diagnostics: readonly Diagnostic[]; exitCode: number }> {
  let stdout = "";
  let exitCode = 0;
  try {
    ({ stdout } = await execFileAsync("node", [CLI_PATH, command, dir, "--format", "json"]));
  } catch (error) {
    const e = error as { stdout?: string; code?: number };
    stdout = e.stdout ?? "";
    exitCode = e.code ?? 1;
  }
  const diagnostics = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Diagnostic & { kind?: string })
    .filter((record) => record.kind === undefined);
  return { diagnostics, exitCode };
}

function forFunction(diagnostics: readonly Diagnostic[], name: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.message.startsWith(`${name} `));
}

/** The route lines of the report for `name` — everything after the summary line. */
function routesFor(diagnostics: readonly Diagnostic[], name: string): readonly string[] {
  const [, ...lines] = (forFunction(diagnostics, name)?.message ?? "").split("\n");
  return lines;
}

describe("AMB-I002 (DESIGN.md §4.1, §4.2 rule 6)", () => {
  it("reports one diagnostic per function, naming each unresolved call and the route its reason implies", async () => {
    const { diagnostics, exitCode } = await run("init", FIXTURE_ROOT);
    expect(exitCode).toBe(0);

    const reported = diagnostics.filter((d) => d.id === "AMB-I002");
    expect(reported.every((d) => d.severity === "info" && d.category === "effects")).toBe(true);
    expect(reported.every((d) => d.docs === "docs/diagnostics/README.md#amb-i002")).toBe(true);

    // One per function, never one per unresolved call: `callsNewFunction`
    // holds two and produces a single diagnostic listing both.
    const byFunction = new Set(reported.map((d) => d.message.split(" ")[0]));
    expect(byFunction.size).toBe(reported.length);
    expect(routesFor(diagnostics, "callsNewFunction")).toHaveLength(2);
    expect(forFunction(diagnostics, "callsNewFunction")?.message).toContain("2 calls");
    expect(forFunction(diagnostics, "callsExternalModule")?.message).toContain("1 call in");
  });

  it("routes each reason to what that reason actually implies", async () => {
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    const route = (name: string): string => routesFor(diagnostics, name).join("\n");

    // A third-party declaration: a stub, or explicit isolation — named with
    // the accounting §4.3 gives it, never as a fix (ADR-0011).
    expect(route("callsExternalModule")).toContain("node:path.resolve (app.ts:");
    expect(route("callsExternalModule")).toContain("external-module");
    expect(route("callsExternalModule")).toContain("a stub for that package");
    expect(route("callsExternalModule")).toContain("tallies separately");

    expect(route("callsMissingImport")).toContain("import-binding");
    expect(route("callsMissingImport")).toContain("doesNotExist (app.ts:");
    expect(route("callsProjectAmbient")).toContain("ambient-declaration");
    expect(route("callsProjectAmbient")).toContain(".d.ts belonging to this project");

    // Ambit's own table, not the reader's code.
    expect(route("callsBuiltinMethod")).toContain("builtin-method");
    expect(route("callsBuiltinMethod")).toContain("Date.setFullYear (app.ts:");
    expect(route("callsBuiltinMethod")).toContain("a gap in Ambit, not in this codebase");

    // Decided at the call sites, per §4.2 rule 4 — both the parameter called
    // directly and the one handed to a mutator by reference.
    expect(route("callsCallbackParameter")).toContain("callback-parameter");
    expect(route("callsCallbackParameter")).toContain("§4.2 rule 4");
    expect(route("sortsWithCallbackByReference")).toContain("callback-by-reference");
    expect(route("sortsWithCallbackByReference")).toContain("§4.2 rule 4");

    expect(route("callsAnyTyped")).toContain("any-typed");
    expect(route("callsAnyTyped")).toContain("a type annotation on that value");

    // §4.2 rule 6 — unanalyzable by design, so the route says so rather than
    // asking for work that would not help.
    for (const name of ["callsDynamicImport", "callsEval", "callsNewFunction"]) {
      expect(route(name)).toContain("not analyzable by design (§4.2 rule 6)");
    }
    expect(route("callsDynamicImport")).toContain("dynamic-import");
    expect(route("callsEval")).toContain("eval");
    expect(route("callsNewFunction")).toContain("new-function");

    expect(route("callsBodylessDeclaration")).toContain("overload-without-body");
    expect(route("callsBodylessDeclaration")).toContain("no implementation in the project");

    expect(route("callsThroughUnknownReceiver")).toContain("unresolved-symbol");
    expect(route("callsThroughUnknownReceiver")).toContain("§4.2 rule 7");
  });

  it("carries no fixes at all — reporting why a contract cannot be written is not proposing one", async () => {
    // DESIGN.md §5.3: `fixes[].edits` are concrete applicable patches. Every
    // route here is a person's decision or work on Ambit itself, so there is
    // no patch to emit — and §4.3's accounting is why `@boundary` in
    // particular is never offered as one (ADR-0011).
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    const reported = diagnostics.filter((d) => d.id === "AMB-I002");
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.flatMap((d) => d.fixes)).toEqual([]);
    expect(reported.every((d) => d.fixes.length === 0)).toBe(true);
  });

  it("states no effect set: a partial set would read as the complete one", async () => {
    // `EffectsContract.observed` has no spelling for `unknown`, so listing
    // what resolved so far would raise the apparent guarantee surface.
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    expect(
      diagnostics.filter((d) => d.id === "AMB-I002").every((d) => d.contract === undefined),
    ).toBe(true);
  });

  it("gives a resolvable function AMB-I001 and no AMB-I002", async () => {
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    const proposal = forFunction(diagnostics, "resolvable");
    expect(proposal?.id).toBe("AMB-I001");
    expect(proposal?.fixes[0]?.edits[0]?.replacement).toContain("@effects pure");
    expect(
      diagnostics.filter((d) => d.id === "AMB-I002" && d.message.startsWith("resolvable ")),
    ).toEqual([]);
  });

  it("reports the leaf that holds the unresolved call, not the callers that inherited unknown", async () => {
    // `inheritsUnknown` calls `callsEval` and holds no unresolvable call of
    // its own. Reporting it too would say the same thing once per caller.
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    expect(forFunction(diagnostics, "callsEval")?.id).toBe("AMB-I002");
    expect(forFunction(diagnostics, "inheritsUnknown")).toBeUndefined();
  });

  it("says nothing about a function that already declares @effects, or one behind @boundary", async () => {
    // A declared function's unresolved call is its own AMB-W001, and a
    // boundary's body was never analyzed — neither is an init proposal.
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    expect(forFunction(diagnostics, "declaredDespiteUnknown")).toBeUndefined();
    expect(forFunction(diagnostics, "isolated")).toBeUndefined();
  });

  it("is emitted by `init` only, never by `check`", async () => {
    const { diagnostics } = await run("check", FIXTURE_ROOT);
    expect(diagnostics.filter((d) => d.id.startsWith("AMB-I"))).toEqual([]);
  });
});
