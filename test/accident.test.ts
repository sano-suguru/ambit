import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const ACCIDENT_FIXTURES = path.join(import.meta.dirname, "fixtures", "accident");

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

/**
 * The accident this project exists to stop: an agent adds one line to a
 * function two calls away from a `@effects pure` declaration
 * (`test/fixtures/accident/rates.ts`'s `void fetch(...)`), and nothing in the
 * type system objects.
 *
 * The path crosses three files on purpose. A lint rule sees one AST node at a
 * time, so a single-file example would not show what Ambit adds; what has to
 * survive is the whole chain from the declaring function to the operation.
 *
 * Every expected value is read out of the CLI's own `--format json` run, so
 * this test cannot pass against hand-written strings that the CLI no longer
 * produces.
 */
describe("the accident: one added line, a call path across three files", () => {
  it("fails the check, prints every hop, and annotates CI with the same path", async () => {
    const json = await runCli(["check", ACCIDENT_FIXTURES, "--format", "json"]);
    const text = await runCli(["check", ACCIDENT_FIXTURES]);
    const github = await runCli(["check", ACCIDENT_FIXTURES, "--format", "github"]);

    // (a) the check fails, in every format.
    expect(json.exitCode).toBe(1);
    expect(text.exitCode).toBe(1);
    expect(github.exitCode).toBe(1);

    const diagnostics = json.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => !record.kind);
    expect(diagnostics).toHaveLength(1);
    const diagnostic = diagnostics[0];
    expect(diagnostic.id).toBe("AMB-E001");

    // The path is what a per-node lint rule cannot produce: more than one hop,
    // and more than one file between the declaration and the operation.
    const via = diagnostic.contract.via;
    expect(via.length).toBeGreaterThan(1);
    const files = new Set([
      diagnostic.location.file,
      ...via.map((hop: { file: string }) => hop.file),
      diagnostic.contract.operation.file,
    ]);
    expect(files.size).toBeGreaterThan(2);

    // (b) the human-readable output carries the declaring function, every hop,
    // and the operation site, each with its own file:line.
    const lines = text.stdout.split("\n");
    expect(lines[0]).toBe(
      `${diagnostic.severity}: ${diagnostic.message} (${diagnostic.location.file}:${diagnostic.location.line})`,
    );
    for (const [index, hop] of via.entries()) {
      const name = hop.symbol.split("#")[1];
      expect(lines[index + 1]).toBe(`  -> ${name} (${hop.file}:${hop.line})`);
    }
    const { qualifiedName, file, line } = diagnostic.contract.operation;
    expect(lines[via.length + 1]).toBe(`  operation: ${qualifiedName} (${file}:${line})`);

    // (c) the CI-facing line is one workflow command carrying the same path.
    const command = github.stdout.split("\n").find((l) => l.startsWith("::"));
    expect(command).toBeDefined();
    const workspaceFile = path
      .relative(process.cwd(), path.join(ACCIDENT_FIXTURES, diagnostic.location.file))
      .split(path.sep)
      .join("/");
    const hops = via
      .map((hop: { symbol: string; file: string; line: number }) => {
        const name = hop.symbol.split("#")[1];
        return `%0A-> ${name} (${hop.file}:${hop.line})`;
      })
      .join("");
    expect(command).toBe(
      `::error file=${workspaceFile},line=${diagnostic.location.line},col=${diagnostic.location.col},title=${diagnostic.id}::${diagnostic.message}${hops}%0Aoperation: ${qualifiedName} (${file}:${line})`,
    );
  });
});
