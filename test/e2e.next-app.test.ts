import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../src/core/index.ts";

/**
 * `test/fixtures/next-app` end to end: a project shaped the way Next.js's App
 * Router requires — `app/**\/route.ts` modules exporting one function per HTTP
 * method, including a `[id]` dynamic segment — with the contract carried by
 * `ambitRoute` beside each handler.
 *
 * The fixture depends on nothing installed: `next/server`, `pg` and
 * `ambit/runtime` / `ambit/runtime/next` are declared under `types/` and the
 * tsconfig sets `types: []`, so a scratch copy outside the repository resolves
 * exactly the same way — the same condition `test/fixtures/realistic-api`
 * meets.
 *
 * `app/status/route.ts` is the boundary this fixture also records: it sets
 * `export const runtime = "edge"` and is deliberately **not** wrapped, because
 * none of the hooks `ambitRoute` depends on are installed on the Edge runtime
 * (DESIGN.md §12, "Edge runtimes": Phase 1 guarantees Node.js only).
 */

const execFileAsync = promisify(execFile);
const CLI_PATH = path.join(import.meta.dirname, "..", "src", "cli", "main.ts");
const FIXTURE_ROOT = path.join(import.meta.dirname, "fixtures", "next-app");

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
  // A real diagnostic carries no `kind`; the trailing `summary` record and
  // the per-function `authority` records (DESIGN.md §5.1) do, and both have
  // to be left out before anything reads these as diagnostics.
  const diagnostics = stdout
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Diagnostic & { readonly kind?: string })
    .filter((record) => record.kind === undefined);
  return { diagnostics, exitCode };
}

async function scratchCopy(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-next-app-"));
  await fs.cp(FIXTURE_ROOT, dir, { recursive: true });
  return dir;
}

function errors(result: CheckResult): readonly Diagnostic[] {
  return result.diagnostics.filter((d) => d.severity === "error");
}

describe("the Next.js App Router fixture (DESIGN.md §4.4)", () => {
  it("type-checks as a scratch copy with nothing installed (P5)", async () => {
    const dir = await scratchCopy();
    try {
      const tsc = path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsc");
      const result = await execFileAsync(tsc, ["--noEmit", "-p", dir]).catch(
        (error: { stdout?: string }) => ({ stdout: error.stdout ?? "failed" }),
      );
      expect(result.stdout).toBe("");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("passes check with no errors as written", async () => {
    const result = await check(FIXTURE_ROOT);
    expect(errors(result)).toEqual([]);
    expect(result.exitCode).toBe(0);
  }, 60_000);

  it("reads each ambitRoute spec as the handler's own @capabilities", async () => {
    // None of the four handlers writes `@capabilities` or `@budget`; the
    // literal spec is the declaration (§4.4, "Removing the double
    // declaration"). If the checker
    // did not read `ambitRoute`, every one of them would be an @entrypoint
    // with no capability set — AMB-W002 — and this would fail.
    const result = await check(FIXTURE_ROOT);
    expect(result.diagnostics.filter((d) => d.id === "AMB-W002")).toEqual([]);
  }, 60_000);

  it("catches a route whose spec does not cover the host its handler reaches", async () => {
    // The static half of §4.4's dual enforcement, reached entirely through the
    // spec:
    // `currentRate` writes no `@capabilities`, so the grant this narrowing
    // check compares against is the literal `ambitRoute` spec. It is AMB-E005
    // rather than AMB-E009 because the `fetch` is not in the entrypoint's own
    // body — it is behind `fetchRate`, whose declared requirement the
    // entrypoint's grant has to cover.
    const dir = await scratchCopy();
    try {
      const route = path.join(dir, "app", "rates", "route.ts");
      const source = await fs.readFile(route, "utf8");
      expect(source.split("http:get:rates.example.test")).toHaveLength(2);
      await fs.writeFile(
        route,
        source.replace("http:get:rates.example.test", "http:get:wrong.example.test"),
      );

      const result = await check(dir);
      const found = errors(result).filter((d) => d.id === "AMB-E005");
      expect(found).toHaveLength(1);
      expect(found[0]?.message).toContain("currentRate grants [http:get:wrong.example.test]");
      expect(found[0]?.message).toContain("requires [http:get:rates.example.test]");
      expect(result.exitCode).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves the Edge route uncontracted, so nothing claims it is enforced", async () => {
    // `app/status/route.ts` sets `runtime = "edge"` and has no `ambitRoute`
    // and no `@entrypoint`. Nothing about it should appear as a contract —
    // an entrypoint there would read as enforced on a runtime where no hook
    // is installed.
    const source = await fs.readFile(path.join(FIXTURE_ROOT, "app", "status", "route.ts"), "utf8");
    expect(source).toContain('export const runtime = "edge"');
    // No registration and no contract — the prose above it in the fixture
    // names `ambitRoute` to say why it is absent, so match the import and the
    // call rather than the word.
    expect(source).not.toContain('from "ambit/runtime/next"');
    expect(source).not.toContain("ambitRoute(");
    // A JSDoc tag line, not the word: the prose says why there is no
    // `@entrypoint` here, which is not the same as writing one.
    expect(source).not.toMatch(/^\s*\*\s*@entrypoint\b/m);

    const result = await check(FIXTURE_ROOT);
    expect(result.diagnostics.filter((d) => d.location?.file.includes("status"))).toEqual([]);
  }, 60_000);
});
