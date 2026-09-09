import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packedTarball } from "./support/pack.ts";

const execFileAsync = promisify(execFile);

/**
 * DESIGN.md §6 (`npm install -D`) and P5 (「撤退手順を自動テストする」).
 *
 * Runs the whole distribution path against a project that has nothing to do
 * with this repository: pack a tarball, install it into a scratch directory,
 * drive the installed `ambit` bin, then uninstall and confirm the consumer is
 * left as it was. Nothing here may reach back into the repo — a step that only
 * works from a clone is not a distribution.
 *
 * Two failures this catches that no in-repo test can:
 *
 * - Node refuses to strip types under `node_modules`
 *   (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so a `bin` pointing at
 *   `.ts` cannot run once installed.
 * - npm installs `bin` as a symlink, so the entry-point guard sees
 *   `process.argv[1]` as the symlink and `import.meta.url` as its target.
 *   When that comparison failed, the installed CLI ran nothing and exited 0
 *   — indistinguishable from "checked, no violations" (DESIGN.md §3.4).
 */

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function run(command: string, args: readonly string[], cwd: string): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
  }
}

const CONSUMER_SOURCE = `/** @effects pure */
export function totalPrice(unitPrice: number, quantity: number): number {
  return unitPrice * quantity;
}

/** @effects pure */
export async function fetchRate(): Promise<Response> {
  return fetch("https://rates.example.test");
}

export function applyDiscount(total: number, pct: number): number {
  return total * (1 - pct);
}
`;

const CONSUMER_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "nodenext",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*.ts"],
  },
  null,
  2,
);

describe("distribution: pack, install into a clean project, uninstall", () => {
  let workspace: string;
  let consumer: string;
  let tarball: string;

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ambit-e2e-"));
    consumer = path.join(workspace, "consumer");
    await fs.mkdir(path.join(consumer, "src"), { recursive: true });
    await fs.writeFile(
      path.join(consumer, "package.json"),
      `${JSON.stringify({ name: "ambit-e2e-consumer", version: "1.0.0", private: true, type: "module" }, null, 2)}\n`,
    );
    await fs.writeFile(path.join(consumer, "tsconfig.json"), `${CONSUMER_TSCONFIG}\n`);
    await fs.writeFile(path.join(consumer, "src", "app.ts"), CONSUMER_SOURCE);

    tarball = await packedTarball();

    // The consumer installs its own compiler, exactly as a real project does.
    // Nothing in this test may resolve a tool out of this repository: a step
    // that only works from a clone is not a distribution.
    const installed = await run(
      "npm",
      ["install", "--no-audit", "--no-fund", "-D", tarball, "typescript@5.9.3"],
      consumer,
    );
    expect(installed.exitCode, installed.stderr).toBe(0);
  }, 300_000);

  afterAll(async () => {
    if (workspace) await fs.rm(workspace, { recursive: true, force: true });
  });

  it("installs an executable `ambit` bin", async () => {
    const bin = path.join(consumer, "node_modules", ".bin", "ambit");
    await expect(fs.stat(bin)).resolves.toBeDefined();
  });

  it("ships no .ts source under node_modules (Node cannot strip types there)", async () => {
    const packageDir = path.join(consumer, "node_modules", "ambit");
    const stack = [packageDir];
    const tsFiles: string[] = [];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (dir === undefined) break;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) tsFiles.push(full);
      }
    }
    expect(tsFiles).toEqual([]);
  });

  it("detects a violation through the installed bin and exits 1", async () => {
    const result = await run(
      path.join("node_modules", ".bin", "ambit"),
      ["check", "src"],
      consumer,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("fetchRate declares pure but performs [network] directly");
    // A run that analyzed nothing must never look like a clean run
    // (DESIGN.md §3.4) — the summary line is the evidence it did work.
    expect(result.stdout).toContain("files=1 functions=3 declared=2");
  }, 120_000);

  it("emits NDJSON through the installed bin", async () => {
    const result = await run(
      path.join("node_modules", ".bin", "ambit"),
      ["check", "src", "--format", "json"],
      consumer,
    );
    const lines = result.stdout.trim().split("\n").filter(Boolean);
    const diagnostics = lines.map((line) => JSON.parse(line)).filter((r) => r.kind === undefined);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      id: "AMB-E001",
      severity: "error",
      category: "effects",
      contract: { declared: ["pure"], observed: ["network"] },
      engine: { name: "typescript-legacy" },
    });
    expect(diagnostics[0].location.file).toBe("app.ts");
  }, 120_000);

  it("proposes contracts through the installed bin and exits 0", async () => {
    // `ambit init` is the first command a consumer runs; it has to work from
    // the package, not only from a clone.
    const result = await run(path.join("node_modules", ".bin", "ambit"), ["init", "src"], consumer);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("applyDiscount has no @effects");
    expect(result.stdout).toContain("files=1 functions=3 declared=2");
  }, 120_000);

  it("runs `ambit` through npx, the way a consumer actually invokes it", async () => {
    const result = await run("npx", ["--no-install", "ambit", "check", "src"], consumer);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("fetchRate declares pure but performs [network] directly");
  }, 120_000);

  it("uninstalls cleanly, leaving the consumer's own code untouched and valid", async () => {
    const removed = await run("npm", ["remove", "ambit"], consumer);
    expect(removed.exitCode, removed.stderr).toBe(0);

    // Nothing of Ambit's is left behind …
    await expect(fs.stat(path.join(consumer, "node_modules", "ambit"))).rejects.toThrow();
    await expect(fs.stat(path.join(consumer, "node_modules", ".bin", "ambit"))).rejects.toThrow();
    const manifest = JSON.parse(await fs.readFile(path.join(consumer, "package.json"), "utf8"));
    expect(manifest.devDependencies?.ambit).toBeUndefined();

    // … and the contract declarations left in the source are inert: they are
    // JSDoc comments, so the project still type-checks and still runs
    // (DESIGN.md P5 — 撤退コストは小さい差分であること).
    const source = await fs.readFile(path.join(consumer, "src", "app.ts"), "utf8");
    expect(source).toBe(CONSUMER_SOURCE);
    const typecheck = await run(
      path.join("node_modules", ".bin", "tsc"),
      ["--noEmit", "-p", "."],
      consumer,
    );
    expect(typecheck.exitCode, typecheck.stdout).toBe(0);
    const executed = await run(
      "node",
      [
        "--experimental-strip-types",
        "-e",
        "await import('./src/app.ts').then(m => console.log(m.totalPrice(2, 3)))",
      ],
      consumer,
    );
    expect(executed.stdout.trim()).toBe("6");
  }, 300_000);
});
