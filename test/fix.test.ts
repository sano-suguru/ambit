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
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "fix-scenario");

interface CheckResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
}

async function check(dir: string): Promise<CheckResult> {
  let stdout = "";
  let exitCode = 0;
  try {
    ({ stdout } = await execFileAsync("node", [CLI_PATH, "check", dir, "--format", "json"]));
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

/** Copy the fixture so a test can rewrite it without touching the checked-in file. */
async function scratchCopy(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-fix-"));
  for (const entry of await fs.readdir(FIXTURE_ROOT)) {
    await fs.copyFile(path.join(FIXTURE_ROOT, entry), path.join(dir, entry));
  }
  return dir;
}

describe("fixes[].edits are applicable patches (DESIGN.md §5.3)", () => {
  it("emits one concrete widen patch for AMB-E001, marked as loosening the contract", async () => {
    const { diagnostics, exitCode } = await check(FIXTURE_ROOT);
    expect(exitCode).toBe(1);
    const violation = diagnostics.find((d) => d.id === "AMB-E001");
    expect(violation?.fixes).toHaveLength(1);
    const fix = violation?.fixes[0];
    expect(fix?.kind).toBe("widen");
    // §5.3: a fix that loosens the contract must say so, and must not be
    // ranked above a contract-preserving one that does not exist.
    expect(fix?.consistentWithContract).toBe(false);
    expect(fix?.edits).toHaveLength(1);
    expect(fix?.edits[0]?.replacement).toBe("@effects network");
    expect(fix?.impact?.callersAffected).toContain("pricing.ts#handle");
  });

  it("applies mechanically and clears the diagnostic (a loosening fix)", async () => {
    // This half proves the patch is applicable. It is NOT the release
    // scenario: it removes the violation by widening the contract.
    const dir = await scratchCopy();
    try {
      const { diagnostics } = await check(dir);
      const violation = diagnostics.find((d) => d.id === "AMB-E001");
      const fix = violation?.fixes[0];
      expect(fix).toBeDefined();
      if (!fix) return;

      const file = path.join(dir, fix.edits[0]?.file ?? "");
      const before = await fs.readFile(file, "utf8");
      await fs.writeFile(file, applyEdits(before, fix.edits));

      const after = await check(dir);
      expect(after.diagnostics.filter((d) => d.id === "AMB-E001")).toEqual([]);
      expect(after.exitCode).toBe(0);
      expect(await fs.readFile(file, "utf8")).toContain("@effects network");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("passes re-check after a fix that does not loosen the contract", async () => {
    // The release-candidate scenario: introduce a violation, detect it, fix
    // the *code* so the declared contract holds, re-check clean. The
    // `@effects pure` on applyPricing is untouched.
    const dir = await scratchCopy();
    try {
      const before = await check(dir);
      expect(before.exitCode).toBe(1);
      expect(before.diagnostics.some((d) => d.id === "AMB-E001")).toBe(true);

      const file = path.join(dir, "pricing.ts");
      const source = await fs.readFile(file, "utf8");
      const fixed = source
        .replace(
          "export async function applyPricing(amount: number): Promise<number> {\n  return amount * (await currentRate());\n}",
          "export function applyPricing(amount: number, rate: number): number {\n  return amount * rate;\n}",
        )
        .replace(
          "  return applyPricing(amount);",
          "  return applyPricing(amount, await currentRate());",
        );
      expect(fixed).not.toBe(source);
      await fs.writeFile(file, fixed);

      const after = await check(dir);
      expect(after.exitCode).toBe(0);
      expect(after.diagnostics).toEqual([]);
      // The contract itself is unchanged — the code moved, not the promise.
      expect(await fs.readFile(file, "utf8")).toContain("/** @effects pure */");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
