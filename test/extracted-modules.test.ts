import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyTsBackend } from "../src/checker/index.ts";
import type { ExtractedProject, SkippedFunctionKind } from "../src/core/index.ts";

/**
 * `ExtractedProject.modules` — the per-file record DESIGN.md §6.2's resident
 * store is keyed by.
 *
 * Two properties are asserted, and they are the two that decide whether a
 * resident store built on this can be correct rather than merely fast:
 *
 * 1. **Every source file under the root has one**, including a file that
 *    declares no function and therefore never reaches `files`. A barrel is
 *    exactly that file, and it is the one whose edit changes how its
 *    importers' calls resolve.
 * 2. **The per-file slices re-sum to the project aggregates.** The cold path
 *    reads the project-level fields and the resident store re-sums the
 *    slices; if the two disagree, `check --coverage` disagrees with itself
 *    across the two paths, which §6.2's equivalence law forbids.
 */

const FIXTURES = path.resolve(import.meta.dirname, "fixtures");
const CROSS_MODULE = path.join(FIXTURES, "cross-module");

let cached: Promise<ExtractedProject> | undefined;
function extractCrossModule(): Promise<ExtractedProject> {
  cached ??= legacyTsBackend.extractProject(CROSS_MODULE);
  return cached;
}

function sourceFilesUnder(dir: string): readonly string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      names.push(...sourceFilesUnder(path.join(dir, entry.name)).map((n) => `${entry.name}/${n}`));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      names.push(entry.name);
    }
  }
  return names;
}

describe("ExtractedProject.modules", () => {
  it("has one entry per source file under the root, files with no functions included", async () => {
    const project = await extractCrossModule();
    const modulePaths = [...project.modules.map((m) => m.filePath)].sort();
    expect(modulePaths).toEqual([...sourceFilesUnder(CROSS_MODULE)].sort());
    // The positive control for the assertion above: `files` really is the
    // smaller set, so "one per source file" is a claim with content.
    expect(project.files.length).toBeLessThan(project.modules.length);
  });

  it("carries a re-export-only barrel that contributes no function to `files`", async () => {
    const project = await extractCrossModule();
    // `deep-barrel.ts` is `export { readFileSync } from "./index.ts";` and
    // nothing else — no function, no runtime wrapper, so no `ExtractedFile`.
    expect(project.files.some((file) => file.filePath === "deep-barrel.ts")).toBe(false);
    const barrel = project.modules.find((m) => m.filePath === "deep-barrel.ts");
    expect(barrel).toBeDefined();
    // And the edge that makes it worth keeping: an edit to `index.ts` has to
    // reach `deep-barrel.ts`, which has to reach `deep-barrel-import.ts`.
    expect(barrel?.imports).toEqual(["index.ts"]);
    expect(project.modules.find((m) => m.filePath === "deep-barrel-import.ts")?.imports).toEqual([
      "deep-barrel.ts",
    ]);
  });

  it("records in-root import targets only, and records nothing for a specifier that resolves to nothing", async () => {
    const project = await extractCrossModule();
    // `index.ts` re-exports from `node:fs` and from `./callee.ts`; only the
    // second is a file under the root.
    expect(project.modules.find((m) => m.filePath === "index.ts")?.imports).toEqual(["callee.ts"]);
    expect(project.modules.find((m) => m.filePath === "builtin-named-import.ts")?.imports).toEqual(
      [],
    );
    // `missing-module-import.ts` imports "./no-such-file.ts". No resolution,
    // so no edge — which is exactly why §6.2 makes a file *addition* re-check
    // everything instead of closing over the edges already held.
    expect(project.modules.find((m) => m.filePath === "missing-module-import.ts")?.imports).toEqual(
      [],
    );
  });
});

describe("ExtractedProject.modules re-sums to the project aggregates", () => {
  const ROOTS = ["cross-module", "backend-conformance", "realistic-api", "propagation", "wrappers"];

  for (const root of ROOTS) {
    it(`${root}: skippedFunctions and uncarriedContracts`, async () => {
      const project = await legacyTsBackend.extractProject(path.join(FIXTURES, root));

      const summed = new Map<SkippedFunctionKind, number>();
      for (const module of project.modules) {
        for (const [kind, count] of module.skippedFunctions) {
          summed.set(kind, (summed.get(kind) ?? 0) + count);
        }
      }
      expect([...summed].sort()).toEqual([...project.skippedFunctions].sort());

      // Concatenation, not a set: `uncarriedContracts` reaches the output as
      // a list of diagnostics, so the slices have to reproduce the whole
      // array including its order.
      expect(project.modules.flatMap((m) => [...m.uncarriedContracts])).toEqual([
        ...project.uncarriedContracts,
      ]);
    });
  }
});
