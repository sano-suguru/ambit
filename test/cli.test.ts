import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const PROPAGATION_FIXTURES = path.join(import.meta.dirname, "fixtures", "propagation");
const WARNINGS_ONLY_FIXTURES = path.join(import.meta.dirname, "fixtures", "warnings-only");

async function runCli(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
  }
}

describe("ambit check (CLI)", () => {
  it("exits 1 and emits one NDJSON line per diagnostic when errors are found", async () => {
    const { stdout, exitCode } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    expect(exitCode).toBe(1);

    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      const diagnostic = JSON.parse(line);
      expect(diagnostic).toHaveProperty("id");
      expect(diagnostic).toHaveProperty("severity");
      expect(diagnostic).toHaveProperty("location");
    }
  });

  it("exits 0 when only warnings (no errors) are present", async () => {
    const { stdout, exitCode } = await runCli([
      "check",
      WARNINGS_ONLY_FIXTURES,
      "--format",
      "json",
    ]);
    const diagnostics = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.severity === "warning")).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("exits 2 and writes to stderr when the target directory does not exist", async () => {
    const { exitCode, stderr } = await runCli([
      "check",
      path.join(import.meta.dirname, "fixtures", "does-not-exist"),
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("analysis failed");
  });

  it("--format text prints a human-readable line instead of JSON", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES]);
    const firstLine = stdout.trim().split("\n")[0];
    expect(firstLine).toMatch(/^(error|warning): /);
    expect(() => JSON.parse(firstLine ?? "")).toThrow();
  });

  it("exits 2 and writes to stderr for an unimplemented flag, instead of silently ignoring it", async () => {
    const { exitCode, stderr } = await runCli(["check", PROPAGATION_FIXTURES, "--coverage"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--coverage");
  });

  it("exits 2 and writes to stderr for an invalid --format value", async () => {
    const { exitCode, stderr } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "xml"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--format");
  });

  it("every NDJSON diagnostic carries an engine identity", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const diagnostic = JSON.parse(line);
      expect(diagnostic.engine).toHaveProperty("name");
      expect(diagnostic.engine).toHaveProperty("version");
    }
  });
});
