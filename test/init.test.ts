import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/core/index.ts";
import { applyEdits } from "./support/apply-edits.ts";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "init");

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

async function scratchCopy(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-init-"));
  for (const entry of await fs.readdir(FIXTURE_ROOT)) {
    await fs.copyFile(path.join(FIXTURE_ROOT, entry), path.join(dir, entry));
  }
  return dir;
}

/** The summary record `check` always emits: how much was actually analyzed. */
async function summaryLine(
  dir: string,
): Promise<{ functionsExtracted: number; functionsDeclared: number }> {
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("node", [CLI_PATH, "check", dir, "--format", "json"]));
  } catch (error) {
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  const summary = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind?: string })
    .find((record) => record.kind === "summary");
  if (!summary) throw new Error(`no summary record in check output for ${dir}`);
  return summary as { kind: string } & {
    functionsExtracted: number;
    functionsDeclared: number;
  };
}

function named(diagnostics: readonly Diagnostic[], name: string): Diagnostic | undefined {
  return diagnostics.find((d) => d.message.startsWith(`${name} `));
}

describe("ambit init (DESIGN.md §4.1)", () => {
  it("proposes the observed effect set for each undeclared function", async () => {
    const { diagnostics, exitCode } = await run("init", FIXTURE_ROOT);
    // Contracts left to write are not a failed check.
    expect(exitCode).toBe(0);
    expect(diagnostics.every((d) => d.severity === "info")).toBe(true);
    // Two info ids come out of `init`: a proposal, and the report of why
    // there is none (AMB-I002, `test/init-unresolved.test.ts`).
    expect(new Set(diagnostics.map((d) => d.id))).toEqual(new Set(["AMB-I001", "AMB-I002"]));

    expect(named(diagnostics, "loadConfig")?.fixes[0]?.edits[0]?.replacement).toContain(
      "@effects fs_read",
    );
    expect(named(diagnostics, "addTax")?.fixes[0]?.edits[0]?.replacement).toContain(
      "@effects pure",
    );
    // Effects reached through a call, not performed directly.
    expect(named(diagnostics, "pricedTotal")?.fixes[0]?.edits[0]?.replacement).toContain(
      "@effects network",
    );
  });

  it("proposes nothing for a function whose effects could not be resolved", async () => {
    // The guard that matters: proposing `pure` for an unanalyzable function
    // would convert "could not tell" into a declared guarantee (§4.3). What
    // it gets instead is AMB-I002 — the reason, carrying no patch.
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    const reported = named(diagnostics, "opaque");
    expect(reported?.id).toBe("AMB-I002");
    expect(reported?.fixes).toEqual([]);
    expect(
      diagnostics.filter((d) => d.id === "AMB-I001" && d.message.startsWith("opaque ")),
    ).toEqual([]);
  });

  it("proposes nothing for a function that already declares @effects", async () => {
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    expect(named(diagnostics, "alreadyDeclared")).toBeUndefined();
  });

  it("reports a class with no constructor but offers no patch for it", async () => {
    // The construction has effects, but there is no declaration site: a
    // comment above `class Loader` would be inert (AMB-E003). Reporting with
    // no fix beats proposing a patch that changes nothing.
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    const proposal = named(diagnostics, "Loader.constructor");
    expect(proposal?.id).toBe("AMB-I001");
    expect(proposal?.fixes).toEqual([]);
    expect(proposal?.message).toContain("write an explicit constructor");
  });

  it("marks the proposals it does make as consistent with the contract", async () => {
    // Adding a declaration where there was none cannot contradict one, and
    // the set proposed is exactly what was observed.
    const { diagnostics } = await run("init", FIXTURE_ROOT);
    expect(
      diagnostics.flatMap((d) => d.fixes).every((fix) => fix.consistentWithContract === true),
    ).toBe(true);
  });

  it("round-trips: applying every proposal leaves `ambit check` clean", async () => {
    // The claim `init` has to earn. An inferred contract that `check` would
    // then reject is worse than no proposal at all.
    const dir = await scratchCopy();
    try {
      const { diagnostics } = await run("init", dir);
      expect(diagnostics.length).toBeGreaterThan(0);

      const byFile = new Map<
        string,
        (typeof diagnostics)[number]["fixes"][number]["edits"][number][]
      >();
      for (const diagnostic of diagnostics) {
        for (const edit of diagnostic.fixes[0]?.edits ?? []) {
          const list = byFile.get(edit.file) ?? [];
          list.push(edit);
          byFile.set(edit.file, list);
        }
      }
      for (const [file, edits] of byFile) {
        const full = path.join(dir, file);
        await fs.writeFile(full, applyEdits(await fs.readFile(full, "utf8"), edits));
      }

      const after = await run("check", dir);
      expect(after.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(after.exitCode).toBe(0);

      // Every proposal that carried a patch is consumed. The ones that
      // carried none (a class with no constructor) stay, which is the point:
      // they name work only a person can do.
      const { diagnostics: remainingProposals } = await run("init", dir);
      expect(remainingProposals.filter((d) => d.fixes.length > 0)).toEqual([]);
      expect(remainingProposals.length).toBeGreaterThan(0);
      const source = await fs.readFile(path.join(dir, "app.ts"), "utf8");
      expect(source).toContain("/** @effects fs_read */");
      expect(source).toContain("/** @effects network */");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it("adds the tag to an existing JSDoc block instead of stacking a second one", async () => {
    const dir = await scratchCopy();
    try {
      const { diagnostics } = await run("init", dir);
      const proposal = named(diagnostics, "documentedButUndeclared");
      const edits = proposal?.fixes[0]?.edits ?? [];
      expect(edits).toHaveLength(1);

      const full = path.join(dir, "app.ts");
      await fs.writeFile(full, applyEdits(await fs.readFile(full, "utf8"), edits));
      const source = await fs.readFile(full, "utf8");
      expect(source).toContain("no contract tag: the tag is added to it");
      expect(source).toContain("@effects pure");
      // One block, not two stacked above the same declaration.
      expect(source).not.toContain("*/\n/** @effects");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("leaves every declaration still findable after applying every proposal", async () => {
    // A patch that broke the file would show up as a smaller function count
    // on the next run — the analysis would stop finding declarations it found
    // before. (Type-checking the scratch copy is not the assertion here: it
    // has no `@types/node`, so `node:fs` would not resolve for reasons that
    // have nothing to do with the patch.)
    const dir = await scratchCopy();
    try {
      const before = await summaryLine(dir);
      const { diagnostics } = await run("init", dir);
      const full = path.join(dir, "app.ts");
      const edits = diagnostics.flatMap((d) => d.fixes[0]?.edits ?? []);
      await fs.writeFile(full, applyEdits(await fs.readFile(full, "utf8"), edits));

      const after = await summaryLine(dir);
      expect(after.functionsExtracted).toBe(before.functionsExtracted);
      expect(after.functionsDeclared).toBe(
        before.functionsDeclared + diagnostics.filter((d) => d.fixes.length > 0).length,
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 180_000);
});
