import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
      /call-sites: total=\d+ resolved=\d+ stub=\d+ pure=[1-9]\d* mutation=\d+ unresolved=\d+/,
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

    // A getter, an object-literal member with a non-identifier name, an
    // anonymous default export, and a contract written on a `class` — one
    // diagnostic each, none of them dropped. Exactly four: the fixture's
    // declared function both carries its own contract and contains an inline
    // callback, so a fifth would mean either a false positive on an
    // extractable node or a JSDoc walk-up from the callback to the enclosing
    // declaration.
    const uncarried = diagnostics.filter((d) => d.id === "AMB-E003");
    expect(uncarried).toHaveLength(4);
    for (const diagnostic of uncarried) {
      expect(diagnostic.severity).toBe("error");
      expect(diagnostic.docs).toBe("docs/diagnostics/README.md#amb-e003");
      expect(diagnostic.location.line).toBeGreaterThan(0);
    }
    // A class's construction *is* analyzed — only the place the contract was
    // written is wrong, and the message has to say where it belongs.
    expect(
      uncarried.some((d: { message: string }) =>
        d.message.includes("a class declaration — the contract belongs on its constructor"),
      ),
    ).toBe(true);
  });

  it("prints every via hop with its own file:line, and no path line where there is no path", async () => {
    // DESIGN.md §5: the text output is a rendering of the structured
    // diagnostic, so the hops it prints are exactly `contract.via` — expected
    // values come from the CLI's own JSON run, not from written-out strings.
    const json = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const text = await runCli(["check", PROPAGATION_FIXTURES]);
    const diagnostics = json.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => !record.kind);

    const multiHop = diagnostics.filter((d) => (d.contract?.via ?? []).length > 1);
    expect(multiHop.length).toBeGreaterThan(0);
    for (const diagnostic of diagnostics) {
      for (const hop of diagnostic.contract?.via ?? []) {
        const name = hop.symbol.split("#")[1];
        expect(text.stdout).toContain(`  -> ${name} (${hop.file}:${hop.line})`);
      }
    }

    // A diagnostic with no hops prints no path line: the header must be
    // followed by the next diagnostic, never by a synthesized path.
    const direct = diagnostics.filter((d) => (d.contract?.via ?? []).length === 0);
    expect(direct.length).toBeGreaterThan(0);
    const lines = text.stdout.split("\n");
    for (const diagnostic of direct) {
      const index = lines.findIndex(
        (line) =>
          line.startsWith(`${diagnostic.severity}: ${diagnostic.message} `) &&
          line.endsWith(`(${diagnostic.location.file}:${diagnostic.location.line})`),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      expect(lines[index + 1]).not.toMatch(/^ {2}-> /);
    }
  });

  it("reports the operation site itself, on the line the source performs it", async () => {
    // DESIGN.md §5.2 `contract.operation`: `via` ends at a function's
    // declaration; the operation line is what a reader actually needs.
    const json = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const text = await runCli(["check", PROPAGATION_FIXTURES]);
    const withOperation = json.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.contract?.operation);
    expect(withOperation.length).toBeGreaterThan(0);

    for (const diagnostic of withOperation) {
      const { qualifiedName, file, line } = diagnostic.contract.operation;
      expect(text.stdout).toContain(`  operation: ${qualifiedName} (${file}:${line})`);
      const source = await readFile(path.join(PROPAGATION_FIXTURES, file), "utf8");
      const operationName = qualifiedName.split(".").at(-1);
      expect(source.split("\n")[line - 1]).toContain(operationName);
    }

    // The site is reported for a direct diagnostic too, which has no path at
    // all — that is the case where the declaration line and the operation line
    // differ with nothing else to say so.
    const direct = withOperation.filter((d) => d.contract.via.length === 0);
    expect(direct.length).toBeGreaterThan(0);
    expect(direct.some((d) => d.contract.operation.line !== d.location.line)).toBe(true);
  });

  it("--format github emits one workflow command per diagnostic, carrying the whole path", async () => {
    // DESIGN.md §6: CI integrates through the exit code and structured output,
    // with no dedicated plugin. Expected values come from the CLI's own JSON
    // run, not from written-out strings.
    const json = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const github = await runCli(["check", PROPAGATION_FIXTURES, "--format", "github"]);
    expect(github.exitCode).toBe(1);

    const diagnostics = json.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => !record.kind);
    const commands = github.stdout.split("\n").filter((line) => line.startsWith("::"));
    expect(commands).toHaveLength(diagnostics.length);

    for (const [index, diagnostic] of diagnostics.entries()) {
      const command = commands[index] ?? "";
      const expectedCommand = diagnostic.severity === "error" ? "error" : "warning";
      expect(command.startsWith(`::${expectedCommand} `)).toBe(true);
      expect(command).toContain(`title=${diagnostic.id}`);
      expect(command).toContain(`line=${diagnostic.location.line}`);
      // The annotation's path is resolved from the workspace root, not from
      // the checked directory.
      const file = path.relative(
        process.cwd(),
        path.join(PROPAGATION_FIXTURES, diagnostic.location.file),
      );
      expect(command).toContain(`file=${file}`);
      expect(command).toContain(diagnostic.message);
      for (const hop of diagnostic.contract?.via ?? []) {
        const name = hop.symbol.split("#")[1];
        expect(command).toContain(`%0A-> ${name} (${hop.file}:${hop.line})`);
      }
      const operation = diagnostic.contract?.operation;
      if (operation) {
        expect(command).toContain(
          `%0Aoperation: ${operation.qualifiedName} (${operation.file}:${operation.line})`,
        );
      }
    }
  });

  it("emits one authority record per analyzed function, before the summary line", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const records = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const authority = records.filter((r) => r.kind === "authority");
    const summary = records.find((r) => r.kind === "summary");
    expect(authority.length).toBe(summary.functionsExtracted);
    // The summary must stay the last record: a consumer reading `at(-1)`
    // as the summary predates the authority records and must keep working.
    expect(records.at(-1)).toMatchObject({ kind: "summary" });
    const lastAuthorityIndex = records.findLastIndex((r) => r.kind === "authority");
    expect(lastAuthorityIndex).toBeLessThan(records.indexOf(summary));
  });

  it("an authority record carries symbol, effects, capabilities and entrypoint", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const authority = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => r.kind === "authority");

    for (const record of authority) {
      expect(typeof record.symbol).toBe("string");
      expect(record.symbol).toContain("#");
      expect(typeof record.entrypoint).toBe("boolean");
      expect(record.effects.declared === null || Array.isArray(record.effects.declared)).toBe(true);
      expect(Array.isArray(record.effects.observed)).toBe(true);
      expect(typeof record.effects.unknown).toBe("boolean");
      expect(
        record.capabilities.declared === null || Array.isArray(record.capabilities.declared),
      ).toBe(true);
      expect(Array.isArray(record.capabilities.required)).toBe(true);
      expect(typeof record.capabilities.unknown).toBe("boolean");
    }

    // A declared-`pure` function that reaches network through a callee: the
    // declared empty set and the observed effect are both visible, and the
    // path names the hop that carried it.
    const undeclaredNetwork = authority.find(
      (r) => r.symbol === "undici-fetch.ts#pureCallsUndiciFetch",
    );
    expect(undeclaredNetwork.effects.declared).toEqual([]);
    expect(undeclaredNetwork.effects.observed).toEqual(["network"]);
    expect(undeclaredNetwork.paths).toContainEqual({
      authority: "network",
      kind: "effect",
      via: [],
      operation: { qualifiedName: "undici.fetch", file: "undici-fetch.ts", line: 8 },
    });
  });

  it("distinguishes an undeclared function from one that declared pure", async () => {
    const { stdout } = await runCli(["check", PROPAGATION_FIXTURES, "--format", "json"]);
    const authority = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((r) => r.kind === "authority");

    const undeclared = authority.find(
      (r) => r.symbol === "rule3-unknown.ts#callsSomethingUnresolved",
    );
    const declaredPure = authority.find((r) => r.symbol === "rule3-unknown.ts#pureReachesUnknown");
    expect(undeclared.effects.declared).toBeNull();
    expect(declaredPure.effects.declared).toEqual([]);
  });

  it("does not emit authority records for init, which proposes contracts rather than reporting them", async () => {
    const { stdout } = await runCli(["init", PROPAGATION_FIXTURES, "--format", "json"]);
    const records = stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(records.some((r) => r.kind === "authority")).toBe(false);
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
