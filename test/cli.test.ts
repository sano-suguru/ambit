import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const PROPAGATION_FIXTURES = path.join(import.meta.dirname, "fixtures", "propagation");
const WARNINGS_ONLY_FIXTURES = path.join(import.meta.dirname, "fixtures", "warnings-only");
const PAREN_LESS_NEW_FIXTURES = path.join(import.meta.dirname, "fixtures", "paren-less-new");
const BACKEND_SMOKE_FIXTURES = path.join(import.meta.dirname, "fixtures", "backend-smoke");
const ZERO_FUNCTIONS_FIXTURES = path.join(import.meta.dirname, "fixtures", "zero-functions");
const NO_TS_FILES_FIXTURES = path.join(import.meta.dirname, "fixtures", "no-ts-files");
const BROKEN_TSCONFIG_FIXTURES = path.join(import.meta.dirname, "fixtures", "broken-tsconfig");
const INVALID_EFFECTS_FIXTURES = path.join(import.meta.dirname, "fixtures", "invalid-effects");
const UNCARRIED_CONTRACT_FIXTURES = path.join(
  import.meta.dirname,
  "fixtures",
  "uncarried-contract",
);

async function runCli(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args]);
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.code ?? 1,
    };
  }
}

describe("ambit check --strict", () => {
  it("promotes the unknown warning to an error and exits 1", async () => {
    // DESIGN.md §4.2 rule 3: 「Ambit の `strict: true` でエラーに昇格できる」.
    const plain = await runCli(["check", WARNINGS_ONLY_FIXTURES]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain("warning:");

    const strict = await runCli(["check", WARNINGS_ONLY_FIXTURES, "--strict"]);
    expect(strict.exitCode).toBe(1);
    expect(strict.stdout).toContain("error:");
    expect(strict.stdout).not.toContain("warning:");
  });

  it("keeps the same diagnostic id when promoting severity", async () => {
    const { stdout } = await runCli([
      "check",
      WARNINGS_ONLY_FIXTURES,
      "--format",
      "json",
      "--strict",
    ]);
    const diagnostics = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.kind === undefined);
    expect(diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.id).toBe("AMB-W001");
      expect(diagnostic.severity).toBe("error");
    }
  });
});

describe("ambit check (CLI)", () => {
  it("exits 1 and emits one NDJSON line per diagnostic when errors are found", async () => {
    const { stdout, exitCode } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    expect(exitCode).toBe(1);

    // The trailing summary record (always emitted — see below) is not a
    // diagnostic and carries no "kind" field on a real Diagnostic.
    const lines = stdout.trim().split("\n").filter(Boolean);
    const diagnosticLines = lines.filter((line) => !("kind" in JSON.parse(line)));
    expect(diagnosticLines.length).toBeGreaterThan(0);

    for (const line of diagnosticLines) {
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
      .map((line) => JSON.parse(line))
      .filter((r) => !("kind" in r));

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

  it("does not crash on a parenthesis-less `new` (`NewExpression.arguments` is `undefined`)", async () => {
    const { exitCode, stderr } = await runCli([
      "check",
      PAREN_LESS_NEW_FIXTURES,
      "--format",
      "json",
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  });

  it("--format text prints a human-readable line instead of JSON", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES]);
    const firstLine = stdout.trim().split("\n")[0];
    expect(firstLine).toMatch(/^(error|warning): /);
    expect(() => JSON.parse(firstLine ?? "")).toThrow();
  });

  it("always reports files/functions/declared analyzed, in text format", async () => {
    const { stdout } = await runCli(["check", WARNINGS_ONLY_FIXTURES]);
    const lastLine = stdout.trim().split("\n").at(-1);
    expect(lastLine).toMatch(/^files=\d+ functions=\d+ declared=\d+$/);
  });

  it("always emits a summary NDJSON record, in json format", async () => {
    const { stdout } = await runCli(["check", WARNINGS_ONLY_FIXTURES, "--format", "json"]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    const summary = JSON.parse(lines.at(-1) ?? "{}");
    expect(summary).toMatchObject({ kind: "summary" });
    expect(summary.filesAnalyzed).toBeGreaterThan(0);
    expect(summary.functionsExtracted).toBeGreaterThan(0);
  });

  it("--coverage adds the detailed breakdown after the always-on summary, in text format", async () => {
    const { stdout, exitCode } = await runCli(["check", WARNINGS_ONLY_FIXTURES, "--coverage"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("unknown-rate=");
    expect(stdout).toContain("call-sites: total=");
    expect(stdout).toContain("unresolved-by-reason:");
  });

  it("--coverage adds a coverage NDJSON record after the summary, in json format", async () => {
    const { stdout } = await runCli([
      "check",
      WARNINGS_ONLY_FIXTURES,
      "--format",
      "json",
      "--coverage",
    ]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    const records = lines.map((l) => JSON.parse(l));
    expect(records.some((r) => r.kind === "summary")).toBe(true);
    const coverage = records.find((r) => r.kind === "coverage");
    expect(coverage).toBeDefined();
    expect(coverage).toHaveProperty("functionUnknownRate");
    expect(coverage).toHaveProperty("unresolvedByReason");
    expect(coverage).toHaveProperty("topUnresolvedNames");
  });

  it("without --coverage, only the always-on summary record is emitted (no coverage record)", async () => {
    const { stdout } = await runCli(["check", WARNINGS_ONLY_FIXTURES, "--format", "json"]);
    const records = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(records.some((r) => r.kind === "coverage")).toBe(false);
  });

  it("--coverage counts a known-pure builtin call as pure, not unresolved", async () => {
    const { stdout } = await runCli(["check", BACKEND_SMOKE_FIXTURES, "--coverage"]);
    expect(stdout).toMatch(
      /call-sites: total=\d+ resolved=\d+ stub=\d+ pure=[1-9]\d* unresolved=\d+/,
    );
  });

  it("exits 2 and writes to stderr for an invalid --format value", async () => {
    const { exitCode, stderr } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "xml"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--format");
  });

  it("exits 2 and writes to stderr for an unrecognized flag, instead of silently ignoring it", async () => {
    const { exitCode, stderr } = await runCli(["check", PROPAGATION_FIXTURES, "--bogus"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--bogus");
  });

  it("exits 2 for a project with zero extracted functions (files present, nothing analyzable)", async () => {
    const { exitCode, stderr } = await runCli(["check", ZERO_FUNCTIONS_FIXTURES]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("no analyzable functions");
  });

  it("exits 2 for a project with zero .ts files", async () => {
    const { exitCode, stderr } = await runCli(["check", NO_TS_FILES_FIXTURES]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("no analyzable functions");
  });

  it("exits 2 for a malformed tsconfig.json instead of silently analyzing zero files", async () => {
    const { exitCode, stderr } = await runCli(["check", BROKEN_TSCONFIG_FIXTURES]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("analysis failed");
  });

  it("AMB-E002: a typo'd @effects tag is rejected, not silently narrowed to pure", async () => {
    const { stdout, exitCode } = await runCli([
      "check",
      INVALID_EFFECTS_FIXTURES,
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(1);
    const diagnostics = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => !("kind" in r));

    const forTypoedFn = diagnostics.filter((d) => d.message.startsWith("declaresTypoedEffect "));
    expect(forTypoedFn.map((d) => d.id)).toEqual(["AMB-E002"]);

    const forValidFn = diagnostics.filter((d) => d.message.startsWith("declaresValidEffect "));
    expect(forValidFn).toEqual([]);
  });

  it("reports AMB-E003 for a contract written on a node that cannot carry one", async () => {
    const { stdout, exitCode } = await runCli([
      "check",
      UNCARRIED_CONTRACT_FIXTURES,
      "--format",
      "json",
    ]);
    expect(exitCode).toBe(1);
    const diagnostics = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => !("kind" in r));

    // A getter, an object-literal member with a non-identifier name, and an
    // anonymous default export — one diagnostic each, none of them dropped.
    // Exactly three: the fixture's declared function both carries its own
    // contract and contains an inline callback, so a fourth would mean either
    // a false positive on an extractable node or a JSDoc walk-up from the
    // callback to the enclosing declaration.
    const uncarried = diagnostics.filter((d) => d.id === "AMB-E003");
    expect(uncarried).toHaveLength(3);
    for (const diagnostic of uncarried) {
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.docs).toBe("docs/diagnostics/README.md#amb-e003");
      expect(diagnostic.location.line).toBeGreaterThan(0);
    }
  });

  it("every NDJSON diagnostic carries an engine identity", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const lines = stdout.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const record = JSON.parse(line);
      if (record.kind) continue; // the trailing summary record, not a diagnostic
      expect(record.engine).toHaveProperty("name");
      expect(record.engine).toHaveProperty("version");
    }
  });
});
